using System.Net;
using System.Text.Json;
using Polly;
using ResiliencyTest.Contracts;

namespace ResiliencyTest.Resilience.Pipeline;

/// <summary>
/// The team returns 400 for EVERY failure, so the status code alone can't separate
/// "bad input" (never retry) from "DB timed out" (retry). The server marks the second kind
/// with X-Error-Category: Transient, which promises that nothing was committed.
/// </summary>
public static class FailureClassifier
{
    /// <summary>400 + category Transient. Header first (cheap), body as a fallback.</summary>
    public static async ValueTask<bool> IsTransientAppFailureAsync(Outcome<HttpResponseMessage> outcome, CancellationToken ct)
    {
        if (outcome.Result is not { StatusCode: HttpStatusCode.BadRequest } response) return false;

        if (response.Headers.TryGetValues(WireHeaders.ErrorCategory, out var values))
            return values.Contains(ErrorCategories.Transient, StringComparer.OrdinalIgnoreCase);

        // Several strategies (retry, breaker, fallback) inspect the SAME response. Buffer it, then read the
        // bytes, never the stream: HttpContent caches the stream it hands out, and ReadFromJsonAsync disposes
        // it, so a second stream-based read (or the consumer's final read) would hit ObjectDisposedException.
        await response.Content.LoadIntoBufferAsync(ct);
        try
        {
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            var envelope = JsonSerializer.Deserialize<ErrorEnvelope>(bytes, JsonSerializerOptions.Web);
            return string.Equals(envelope?.ErrorCategory, ErrorCategories.Transient, StringComparison.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return false; // not our envelope, so not something we can classify
        }
    }

    /// <summary>
    /// Failures that happen before the request is written to the wire. The server cannot have
    /// acted on it, so even a non-idempotent command is safe to retry.
    /// </summary>
    public static bool NeverReachedServer(Outcome<HttpResponseMessage> outcome) =>
        outcome.Exception is HttpRequestException
        {
            HttpRequestError: HttpRequestError.NameResolutionError
                           or HttpRequestError.ConnectionError
                           or HttpRequestError.SecureConnectionError
        };

    /// <summary>Short text for logs: "503", "400 Transient", "TimeoutRejectedException".</summary>
    public static string Describe(Outcome<HttpResponseMessage> outcome)
    {
        if (outcome.Exception is { } ex) return ex.GetType().Name;
        if (outcome.Result is not { } r) return "no result";
        var category = r.Headers.TryGetValues(WireHeaders.ErrorCategory, out var v) ? " " + v.First() : string.Empty;
        return $"{(int)r.StatusCode}{category}";
    }
}
