using Microsoft.Extensions.Logging;
using Polly.Timeout;
using ResiliencyTest.Resilience.Options;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// Two timeouts: TOTAL (outside retry/hedging: the caller's whole budget) and
/// ATTEMPT (innermost: one try). TimeoutGenerator reads the per-request override at execution time,
/// so one cached pipeline serves callers with different latency budgets.
/// </summary>
internal static class TimeoutStrategies
{
    public static TimeoutStrategyOptions Total(CustomResilienceOptions options, ILogger logger) => new()
    {
        Name = "TotalTimeout",
        Timeout = options.TotalTimeout,
        TimeoutGenerator = args => ValueTask.FromResult(
            ResilienceContextExtensions.Tighten(args.Context.GetOverrides()?.TotalTimeout, options.TotalTimeout)),
        OnTimeout = args =>
        {
            logger.LogWarning("TOTAL TIMEOUT  gave up after {Timeout:N0}ms", args.Timeout.TotalMilliseconds);
            return default;
        }
    };

    public static TimeoutStrategyOptions Attempt(CustomResilienceOptions options, ILogger logger) => new()
    {
        Name = "AttemptTimeout",
        Timeout = options.AttemptTimeout,
        TimeoutGenerator = args => ValueTask.FromResult(
            ResilienceContextExtensions.Tighten(args.Context.GetOverrides()?.AttemptTimeout, options.AttemptTimeout)),
        OnTimeout = args =>
        {
            logger.LogWarning("ATTEMPT TIMEOUT  one attempt exceeded {Timeout:N0}ms", args.Timeout.TotalMilliseconds);
            return default;
        }
    };
}
