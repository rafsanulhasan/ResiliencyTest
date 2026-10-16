using System.Diagnostics;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using ResiliencyTest.Contracts;
using ResiliencyTest.Resilience.Http;
using ResiliencyTest.Resilience.Requests;

namespace ResiliencyTest.Demo.Scenarios;

public static class Clients
{
    public const string Catalog = "Catalog";     // queries, retry mode
    public const string Orders = "Orders";       // commands, retry mode
    public const string Search = "Search";       // queries, HEDGING mode (Hedging.UsePrecedence = true)
    public const string Inventory = "Inventory"; // tight circuit breaker
    public const string Reports = "Reports";     // tight bulkhead
    public const string Payments = "Payments";   // token-bucket rate limit
    public const string Admin = "Admin";         // no resilience; reads server-side hit counters

    public static readonly string[] All = [Catalog, Orders, Search, Inventory, Reports, Payments];
}

public sealed record Scenario(string Id, string Title, string Explanation, string[] Tags, Func<ScenarioContext, Task> Run);

/// <summary>Per-scenario helpers: unique chaos key, request builder, server hit counter, expectations.</summary>
public sealed class ScenarioContext(IServiceProvider services, string id)
{
    private readonly List<(string What, bool Ok)> _checks = [];

    public string Key { get; } = $"{id}-{Guid.NewGuid():N}"[..(id.Length + 9)];
    public IReadOnlyList<(string What, bool Ok)> Checks => _checks;

    public ICustomHttpClient Client(string name) => services.GetRequiredKeyedService<ICustomHttpClient>(name);

    public UnifiedHttpRequest Request(
        HttpMethod method, string path, string mode = ChaosModes.None, int? failTimes = null, int? delayMs = null,
        object? body = null, bool afterCommit = false, string? idempotencyKey = null,
        ResilienceOverrides? overrides = null, RequestSemantics semantics = RequestSemantics.Auto, string? key = null)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [ChaosHeaders.Key] = key ?? Key,
            [ChaosHeaders.Mode] = mode
        };
        if (failTimes is { } f) headers[ChaosHeaders.FailTimes] = f.ToString();
        if (delayMs is { } d) headers[ChaosHeaders.DelayMs] = d.ToString();
        if (afterCommit) headers[ChaosHeaders.AfterCommit] = "true";

        return new UnifiedHttpRequest
        {
            Method = method, Path = path, Body = body, Headers = headers,
            IdempotencyKey = idempotencyKey, Resilience = overrides, Semantics = semantics
        };
    }

    public async Task<int> ServerHitsAsync(string? key = null)
    {
        var admin = services.GetRequiredService<IHttpClientFactory>().CreateClient(Clients.Admin);
        return await admin.GetFromJsonAsync<int>($"/chaos/hits/{key ?? Key}");
    }

    public async Task<int> OrderCountAsync()
    {
        var admin = services.GetRequiredService<IHttpClientFactory>().CreateClient(Clients.Admin);
        return (await admin.GetFromJsonAsync<QueryResponse<int>>("/orders/count"))!.Data;
    }

    public void Expect(string what, bool ok) => _checks.Add((what, ok));

    public void Show(string label, ResponseBase envelope) =>
        Console.WriteLine($"    {label}: IsSuccess={envelope.IsSuccess}, Category={envelope.ErrorCategory ?? "-"}, Message=\"{envelope.Message}\"");

    public static async Task<(T Result, TimeSpan Elapsed)> TimeAsync<T>(Func<Task<T>> action)
    {
        var sw = Stopwatch.StartNew();
        var result = await action();
        return (result, sw.Elapsed);
    }
}

public sealed partial class ScenarioRunner(IServiceProvider services)
{
    public async Task<bool> RunAsync(string? filter)
    {
        var selected = All()
            .Where(s => filter is null
                        || s.Id.Contains(filter, StringComparison.OrdinalIgnoreCase)
                        || s.Tags.Any(t => t.Contains(filter, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        var failed = new List<string>();
        for (var i = 0; i < selected.Count; i++)
        {
            var scenario = selected[i];
            Write(ConsoleColor.Cyan, $"\n=== [{i + 1}/{selected.Count}] {scenario.Title}  ({scenario.Id})");
            Write(ConsoleColor.DarkGray, $"    {scenario.Explanation}");

            var context = new ScenarioContext(services, scenario.Id);
            try
            {
                await scenario.Run(context);
            }
            catch (Exception ex)
            {
                context.Expect($"no unexpected exception ({ex.GetType().Name}: {ex.Message})", false);
            }

            await Task.Delay(150); // let the async console logger flush before printing the verdict
            foreach (var (what, ok) in context.Checks)
                Write(ok ? ConsoleColor.Green : ConsoleColor.Red, $"    {(ok ? "PASS" : "FAIL")}  {what}");

            if (context.Checks.Any(c => !c.Ok)) failed.Add(scenario.Id);
        }

        Console.WriteLine();
        if (failed.Count == 0)
            Write(ConsoleColor.Green, $"All {selected.Count} scenarios passed.");
        else
            Write(ConsoleColor.Red, $"{failed.Count} of {selected.Count} scenarios failed: {string.Join(", ", failed)}");
        return failed.Count == 0;
    }

    private static void Write(ConsoleColor color, string text)
    {
        Console.ForegroundColor = color;
        Console.WriteLine(text);
        Console.ResetColor();
    }
}
