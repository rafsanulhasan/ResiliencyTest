using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using ResiliencyTest.Resilience.Options;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// CIRCUIT BREAKER. Watches the failure ratio over SamplingDuration. Above FailureRatio (with at least
/// MinimumThroughput calls) it OPENS: calls fail instantly with BrokenCircuitException for BreakDuration,
/// without touching the network. Then HALF-OPEN lets one probe through: success closes, failure re-opens.
///
/// It sits INSIDE retry/hedging so every attempt is counted. Its state is shared by every caller of this
/// client, which is why per-request overrides cannot touch it.
/// </summary>
internal static class CircuitBreakerStrategy
{
    public static HttpCircuitBreakerStrategyOptions Create(CircuitBreakerSettings settings, ILogger logger)
    {
        var options = new HttpCircuitBreakerStrategyOptions
        {
            Name = "CircuitBreaker",
            FailureRatio = settings.FailureRatio,
            MinimumThroughput = settings.MinimumThroughput,
            SamplingDuration = settings.SamplingDuration,
            BreakDuration = settings.BreakDuration,
            OnOpened = args =>
            {
                logger.LogError("CIRCUIT OPENED  for {Break:N0}ms after [{Outcome}]",
                    args.BreakDuration.TotalMilliseconds, FailureClassifier.Describe(args.Outcome));
                return default;
            },
            OnHalfOpened = _ =>
            {
                logger.LogWarning("CIRCUIT HALF-OPEN  letting one probe through");
                return default;
            },
            OnClosed = _ =>
            {
                logger.LogInformation("CIRCUIT CLOSED  dependency healthy again");
                return default;
            }
        };

        // Count infrastructure failures AND app-level Transient 400s (an outage hidden behind a 400).
        // Validation 400s are the caller's fault and must never open the circuit for everyone.
        var isInfrastructureTransient = options.ShouldHandle;
        options.ShouldHandle = async args =>
            await isInfrastructureTransient(args)
            || await FailureClassifier.IsTransientAppFailureAsync(args.Outcome, args.Context.CancellationToken);

        return options;
    }
}
