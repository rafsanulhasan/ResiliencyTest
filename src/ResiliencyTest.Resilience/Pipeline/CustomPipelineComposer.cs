using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;
using Polly;
using ResiliencyTest.Resilience.Options;
using ResiliencyTest.Resilience.Pipeline.Strategies;

namespace ResiliencyTest.Resilience.Pipeline;

/// <summary>
/// Builds the pipeline inside AddResilienceHandler. Runs when the pipeline is BUILT (and again on
/// config reload), not per request, so a plain "if" is enough to choose retry OR hedging.
///
///   Fallback          outermost: turns any final failure into the team's envelope
///   Rate limiter      requests per second (quota)        [optional]
///   Bulkhead          requests in flight at once
///   Total timeout     the caller's whole budget
///   Retry | Hedging   never both
///   Circuit breaker   counts every attempt
///   Attempt timeout   innermost: one try
/// </summary>
public static class CustomPipelineComposer
{
    public static void Compose(
        ResiliencePipelineBuilder<HttpResponseMessage> pipeline,
        CustomResilienceOptions options,
        ILogger logger,
        ResilienceHandlerContext context)
    {
        if (options.Fallback.Enabled)
            pipeline.AddFallback(FallbackStrategy.Create(options.Fallback, logger));

        if (options.RateLimit.Enabled)
        {
            pipeline.AddRateLimiter(RateLimitStrategy.Create(options.RateLimit, logger, out var limiter));
            context.OnPipelineDisposed(limiter.Dispose); // the pipeline is rebuilt on config reload
        }

        if (options.Bulkhead.Enabled)
            pipeline.AddRateLimiter(BulkheadStrategy.Create(options.Bulkhead, logger));

        pipeline.AddTimeout(TimeoutStrategies.Total(options, logger));

        if (options.Hedging.UsePrecedence)
            pipeline.AddHedging(HedgingStrategy.Create(options.Hedging, logger));
        else
            pipeline.AddRetry(RetryStrategy.Create(options.Retry, logger));

        if (options.CircuitBreaker.Enabled)
            pipeline.AddCircuitBreaker(CircuitBreakerStrategy.Create(options.CircuitBreaker, logger));

        pipeline.AddTimeout(TimeoutStrategies.Attempt(options, logger));
    }
}
