using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using Polly;
using ResiliencyTest.Resilience.Options;
using ResiliencyTest.Resilience.Requests;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// RETRY with exponential backoff + jitter. Sequential, reacts to FAILURE.
///
/// Note what is NOT here: DisableForUnsafeHttpMethods(). The team uses POST for fetches, so the
/// HTTP method says nothing about safety. The decision is made from RequestSemantics instead.
/// </summary>
internal static class RetryStrategy
{
    public static HttpRetryStrategyOptions Create(RetrySettings settings, ILogger logger)
    {
        var options = new HttpRetryStrategyOptions
        {
            Name = "Retry",
            MaxRetryAttempts = settings.MaxRetryAttempts,   // hard ceiling; overrides can only lower it
            BackoffType = DelayBackoffType.Exponential,     // 100ms, 200ms, 400ms ...
            UseJitter = settings.UseJitter,                 // ... randomized, so clients don't retry in lockstep
            Delay = settings.BaseDelay,
            MaxDelay = settings.MaxDelay,
            ShouldRetryAfterHeader = true,                  // honor Retry-After on 429/503
            OnRetry = args =>
            {
                logger.LogWarning("RETRY #{Attempt}  in {Delay:N0}ms after [{Outcome}] ({Semantics})",
                    args.AttemptNumber + 1, args.RetryDelay.TotalMilliseconds,
                    FailureClassifier.Describe(args.Outcome), args.Context.GetSemantics());
                return default;
            }
        };

        // Default predicate: 408, 429, 5xx, HttpRequestException, TimeoutRejectedException.
        var isInfrastructureTransient = options.ShouldHandle;

        options.ShouldHandle = async args =>
        {
            // 1. Per-request overrides (can only tighten).
            var overrides = args.Context.GetOverrides();
            if (overrides?.DisableRetry == true) return false;
            if (overrides?.MaxRetryAttempts is int max && args.AttemptNumber >= max) return false;

            // 2. Server said Transient: by contract nothing was committed. Safe for every semantics.
            if (await FailureClassifier.IsTransientAppFailureAsync(args.Outcome, args.Context.CancellationToken))
                return true;

            // 3. Validation 400s, 200s, success: not our business.
            if (!await isInfrastructureTransient(args)) return false;

            // 4. Infrastructure failure: is the outcome of the original request known?
            return args.Context.GetSemantics() switch
            {
                RequestSemantics.Query or RequestSemantics.IdempotentCommand => true,
                // A 500/timeout on a command may have committed. Only retry if it never left this machine.
                RequestSemantics.Command => FailureClassifier.NeverReachedServer(args.Outcome),
                _ => false
            };
        };

        return options;
    }
}
