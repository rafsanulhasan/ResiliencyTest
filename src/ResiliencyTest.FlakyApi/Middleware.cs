using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using ResiliencyTest.Contracts;

namespace ResiliencyTest.FlakyApi;

/// <summary>Server-side DB timeout / deadlock / downstream outage. The transaction was rolled back.</summary>
public sealed class TransientServerException(string message) : Exception(message);

public sealed class ValidationFailedException(string message) : Exception(message);

/// <summary>
/// The team's global exception handler: EVERY failure becomes a 400 envelope.
/// The recommended addition is the X-Error-Category header + field, so clients can tell
/// "retry me" (Transient) from "your input is wrong" (Validation).
/// </summary>
internal sealed class ErrorEnvelopeMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http)
    {
        try
        {
            await next(http);
        }
        catch (OperationCanceledException) when (http.RequestAborted.IsCancellationRequested)
        {
            // Client gave up: attempt timeout fired, or this was the losing side of a hedge.
        }
        catch (Exception ex)
        {
            var category = ex switch
            {
                TransientServerException => ErrorCategories.Transient,
                ValidationFailedException => ErrorCategories.Validation,
                _ => null // unclassified: how most global handlers behave today
            };

            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            if (category is not null) http.Response.Headers[WireHeaders.ErrorCategory] = category;
            await http.Response.WriteAsJsonAsync(new ErrorEnvelope { IsSuccess = false, Message = ex.Message, ErrorCategory = category });
        }
    }
}

internal sealed class ChaosState
{
    private readonly ConcurrentDictionary<string, int> _hits = new();
    public int Hit(string key) => _hits.AddOrUpdate(key, 1, (_, n) => n + 1);
    public int Hits(string key) => _hits.GetValueOrDefault(key);
}

/// <summary>Injects failures driven by X-Chaos-* headers, counting hits per X-Chaos-Key.</summary>
internal sealed class ChaosMiddleware(RequestDelegate next, ChaosState state, ILoggerFactory loggers)
{
    private const string FailingItem = "chaos.failing";
    private readonly ILogger _log = loggers.CreateLogger("FlakyApi");

    public static bool ShouldFailAfterCommit(HttpContext http) =>
        http.Items[FailingItem] is true
        && bool.TryParse(http.Request.Headers[ChaosHeaders.AfterCommit], out var afterCommit) && afterCommit
        && http.Request.Headers[ChaosHeaders.Mode] == ChaosModes.Status503;

    public async Task InvokeAsync(HttpContext http)
    {
        var headers = http.Request.Headers;
        var key = headers[ChaosHeaders.Key].ToString();
        if (string.IsNullOrEmpty(key) || http.Request.Path.StartsWithSegments("/chaos"))
        {
            await next(http);
            return;
        }

        var hit = state.Hit(key);
        var mode = headers[ChaosHeaders.Mode].ToString() is { Length: > 0 } m ? m : ChaosModes.None;
        var failTimes = int.TryParse(headers[ChaosHeaders.FailTimes], out var f) ? f : int.MaxValue;
        var delayMs = int.TryParse(headers[ChaosHeaders.DelayMs], out var d) ? d : 0;
        var afterCommit = bool.TryParse(headers[ChaosHeaders.AfterCommit], out var a) && a;
        var failing = hit <= failTimes;
        http.Items[FailingItem] = failing;
        var slow = mode == ChaosModes.Slow || (mode == ChaosModes.SlowFirst && hit == 1);
        var failureMode = mode is ChaosModes.Transient400 or ChaosModes.Validation400 or ChaosModes.Unknown400 or ChaosModes.Status503;

        _log.LogInformation("  [server] {Method} {Path} hit #{Hit} (client attempt {Attempt}) mode={Mode}{Outcome}",
            http.Request.Method, http.Request.Path, hit, headers[WireHeaders.ClientAttempt].ToString(), mode,
            failureMode && failing ? (afterCommit ? " -> fail AFTER commit" : " -> fail")
            : slow ? $" -> slow ({delayMs}ms)" : " -> ok");

        if (slow)
            await Task.Delay(delayMs, http.RequestAborted);

        if (failing && !afterCommit)
        {
            switch (mode)
            {
                case ChaosModes.Transient400:
                    throw new TransientServerException("Database timeout (simulated). The transaction was rolled back.");
                case ChaosModes.Validation400:
                    throw new ValidationFailedException("The request is invalid (simulated validation failure).");
                case ChaosModes.Unknown400:
                    throw new InvalidOperationException("Something went wrong (simulated, unclassified).");
                case ChaosModes.Status503:
                    http.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                    http.Response.ContentType = "text/plain";
                    await http.Response.WriteAsync("Service Unavailable (simulated gateway)");
                    return;
            }
        }

        await next(http);
    }
}

internal sealed class OrderStore
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Order> _byIdempotencyKey = new();
    private readonly Dictionary<string, Order> _byId = new();

    public int Count { get { lock (_gate) return _byId.Count; } }

    public (Order Order, bool Replayed) Create(CreateOrder command, string? idempotencyKey)
    {
        lock (_gate)
        {
            if (!string.IsNullOrEmpty(idempotencyKey) && _byIdempotencyKey.TryGetValue(idempotencyKey, out var existing))
                return (existing, true);

            var order = new Order(Guid.NewGuid().ToString("N")[..8], command.ProductId, command.Quantity, DateTimeOffset.UtcNow);
            _byId[order.Id] = order;
            if (!string.IsNullOrEmpty(idempotencyKey)) _byIdempotencyKey[idempotencyKey] = order;
            return (order, false);
        }
    }

    public bool Delete(string id)
    {
        lock (_gate) return _byId.Remove(id);
    }
}
