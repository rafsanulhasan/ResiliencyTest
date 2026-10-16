using System.Threading.RateLimiting;
using Microsoft.Extensions.Logging;
using Polly.RateLimiting;
using ResiliencyTest.Resilience.Options;

namespace ResiliencyTest.Resilience.Pipeline.Strategies;

/// <summary>
/// RATE LIMITING: caps requests STARTED per time window (token bucket).
/// Answers "am I allowed to call this often?" and protects the downstream's quota.
/// Latency doesn't matter to it: 5/sec is 5/sec whether calls take 10ms or 10s.
/// </summary>
internal static class RateLimitStrategy
{
    public static RateLimiterStrategyOptions Create(RateLimitSettings settings, ILogger logger, out RateLimiter limiter)
    {
        var bucket = new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
        {
            TokenLimit = settings.TokenLimit,
            TokensPerPeriod = settings.TokensPerPeriod,
            ReplenishmentPeriod = settings.ReplenishmentPeriod,
            QueueLimit = settings.QueueLimit,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            AutoReplenishment = true
        });
        limiter = bucket;

        return new RateLimiterStrategyOptions
        {
            Name = "RateLimit",
            RateLimiter = args => bucket.AcquireAsync(1, args.Context.CancellationToken),
            OnRejected = args =>
            {
                args.Context.Properties.Set(CustomResilienceKeys.RejectedBy, "rate-limited");
                logger.LogWarning("RATE LIMIT  rejected: more than {Tokens} requests per {Period}",
                    settings.TokensPerPeriod, settings.ReplenishmentPeriod);
                return default;
            }
        };
    }
}

/// <summary>
/// BULKHEAD: caps requests IN FLIGHT at the same time (concurrency limiter + small queue).
/// Answers "can I afford this many calls waiting at once?" and protects THIS process:
/// a slow dependency can tie up at most N slots instead of every socket and thread.
/// Polly v8 has no separate bulkhead type; a concurrency limiter IS the bulkhead.
/// </summary>
internal static class BulkheadStrategy
{
    public static RateLimiterStrategyOptions Create(BulkheadSettings settings, ILogger logger) => new()
    {
        Name = "Bulkhead",
        DefaultRateLimiterOptions = new ConcurrencyLimiterOptions
        {
            PermitLimit = settings.PermitLimit,
            QueueLimit = settings.QueueLimit,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst
        },
        OnRejected = args =>
        {
            args.Context.Properties.Set(CustomResilienceKeys.RejectedBy, "bulkhead-full");
            logger.LogWarning("BULKHEAD  rejected: {Permits} in flight and {Queue} queued already",
                settings.PermitLimit, settings.QueueLimit);
            return default;
        }
    };
}
