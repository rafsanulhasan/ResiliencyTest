using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Polly;
using Polly.CircuitBreaker;
using Polly.Fallback;
using Polly.RateLimiting;
using Polly.Timeout;
using ResiliencyTest.Contracts;
using ResiliencyTest.Resilience.Options;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// OUTERMOST strategy. When everything inside has given up (retries exhausted, circuit open,
/// bulkhead/rate limit full, timeout), replace the failure with a response in the TEAM'S envelope
/// shape, so consumers parse it like any other 400. It never fixes anything; it degrades gracefully.
/// </summary>
internal static class FallbackStrategy
{
    public static FallbackStrategyOptions<HttpResponseMessage> Create(FallbackSettings settings, ILogger logger) => new()
    {
        Name = "Fallback",
        ShouldHandle = async args =>
        {
            if (args.Context.GetOverrides()?.DisableFallback == true) return false;

            return args.Outcome switch
            {
                { Exception: BrokenCircuitException or TimeoutRejectedException
                             or RateLimiterRejectedException or HttpRequestException } => true,
                { Result: { } r } when (int)r.StatusCode >= 500
                                    || r.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests => true,
                // Validation 400s are real answers and pass through untouched.
                _ => await FailureClassifier.IsTransientAppFailureAsync(args.Outcome, args.Context.CancellationToken)
            };
        },
        FallbackAction = args =>
        {
            var reason = Reason(args.Outcome, args.Context);
            args.Outcome.Result?.Dispose(); // we are replacing it

            var response = new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = JsonContent.Create(new ErrorEnvelope
                {
                    IsSuccess = false,
                    Message = $"[fallback:{reason}] {settings.Message}",
                    ErrorCategory = ErrorCategories.Transient
                })
            };
            response.Headers.Add(WireHeaders.ErrorCategory, ErrorCategories.Transient);
            response.Headers.Add(WireHeaders.ResilienceFallback, reason); // never let a fallback look like a healthy call
            return Outcome.FromResultAsValueTask(response);
        },
        OnFallback = args =>
        {
            logger.LogWarning("FALLBACK  replaced [{Outcome}] with a degraded envelope", FailureClassifier.Describe(args.Outcome));
            return default;
        }
    };

    private static string Reason(Outcome<HttpResponseMessage> outcome, ResilienceContext context) => outcome.Exception switch
    {
        BrokenCircuitException => "circuit-open",
        TimeoutRejectedException => "timeout",
        RateLimiterRejectedException => context.Properties.GetValue(CustomResilienceKeys.RejectedBy, "rejected"),
        HttpRequestException => "connection",
        _ => outcome.Result is { } r ? $"http-{(int)r.StatusCode}" : "unknown"
    };
}
