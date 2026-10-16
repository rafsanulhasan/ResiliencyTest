using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ResiliencyTest.Demo.Scenarios;
using ResiliencyTest.FlakyApi;
using ResiliencyTest.Resilience.DependencyInjection;

// Usage:
//   dotnet run --project src/ResiliencyTest.Demo            -> run every scenario
//   dotnet run --project src/ResiliencyTest.Demo -- hedging -> only scenarios whose id/tag contains "hedging"

var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory // find appsettings.json no matter where you run from
});

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o =>
{
    o.SingleLine = true;
    o.TimestampFormat = "HH:mm:ss.fff ";
    o.IncludeScopes = false;
});

// One registration per downstream dependency. Each gets its OWN pipeline, so its circuit breaker,
// bulkhead and rate limiter are isolated from the others.
foreach (var name in Clients.All)
    builder.Services.AddCustomHttpClient(name, builder.Configuration);

var apiUrl = builder.Configuration["FlakyApi:Url"] ?? "http://127.0.0.1:5199";
builder.Services.AddHttpClient(Clients.Admin, c => c.BaseAddress = new Uri(apiUrl)); // plain client for test hooks
builder.Services.AddSingleton<ScenarioRunner>();

await using var api = await FlakyApiServer.StartAsync(apiUrl);

using var host = builder.Build();
await host.StartAsync(); // runs ValidateOnStart for every client's options

var runner = host.Services.GetRequiredService<ScenarioRunner>();
var passed = await runner.RunAsync(filter: args.FirstOrDefault(a => !a.StartsWith('-')));

await host.StopAsync();
return passed ? 0 : 1;
