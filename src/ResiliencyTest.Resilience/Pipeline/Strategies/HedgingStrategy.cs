using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using ResiliencyTest.Resilience.Options;
using ResiliencyTest.Resilience.Requests;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// HEDGING. Parallel, acts on SLOWNESS: if the primary hasn't answered within Delay, fire a copy,
/// take whichever finishes first, cancel the rest. Also re-issues immediately on a handled failure,
/// which is why it replaces retry rather than sitting next to it.
///
/// Only QUERIES are hedged. Even an idempotent write must not run as concurrent duplicates:
/// two in-flight requests with the same Idempotency-Key can race in the server's dedupe logic.
/// </summary>
internal static class HedgingStrategy
{
    public static HttpHedgingStrategyOptions Create(HedgingSettings settings, ILogger logger)
    {
        var options = new HttpHedgingStrategyOptions
        {
            Name = "Hedging",
            MaxHedgedAttempts = settings.MaxHedgedAttempts,
            Delay = settings.Delay,
            // A caller may ask to hedge LATER (less extra load), never sooner than configured.
            DelayGenerator = args => ValueTask.FromResult(
                args.Context.GetOverrides()?.HedgingDelay is { } d && d > settings.Delay ? d : settings.Delay),
            OnHedging = args =>
            {
                logger.LogWarning("HEDGE #{Attempt}  fired: primary is slow or failed", args.AttemptNumber + 1); // zero-based
                return default;
            }
        };

        // Default: 408, 429, 5xx, HttpRequestException, BrokenCircuitException, TimeoutRejectedException.
        var isInfrastructureTransient = options.ShouldHandle;
        options.ShouldHandle = async args =>
            await isInfrastructureTransient(args)
            || await FailureClassifier.IsTransientAppFailureAsync(args.Outcome, args.Context.CancellationToken);

        // Returning null from the generator means "do not create this hedged attempt".
        var generate = options.ActionGenerator;
        options.ActionGenerator = args =>
        {
            if (args.PrimaryContext.GetSemantics() != RequestSemantics.Query) return null;

            var overrides = args.PrimaryContext.GetOverrides();
            if (overrides?.DisableHedging == true) return null;
            if (overrides?.MaxHedgedAttempts is int max && args.AttemptNumber > max) return null;

            return generate(args);
        };

        return options;
    }
}
