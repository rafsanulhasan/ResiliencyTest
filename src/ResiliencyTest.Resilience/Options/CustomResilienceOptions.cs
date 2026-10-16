namespace ResiliencyTest.Resilience.Options;

/// <summary>
/// One instance per downstream dependency, bound from "Resilience:{ClientName}" in appsettings.
/// These values are the CEILINGS. Per-request overrides can only tighten them (see ResilienceOverrides).
/// </summary>
public sealed class CustomResilienceOptions
{
    public const string SectionRoot = "Resilience";

    public string BaseAddress { get; set; } = string.Empty;

    /// <summary>Budget for the whole call, including every retry/hedge and backoff delay.</summary>
    public TimeSpan TotalTimeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Budget for a single attempt. Must be smaller than <see cref="TotalTimeout"/>.</summary>
    public TimeSpan AttemptTimeout { get; set; } = TimeSpan.FromSeconds(10);

    public FallbackSettings Fallback { get; set; } = new();
    public RateLimitSettings RateLimit { get; set; } = new();
    public BulkheadSettings Bulkhead { get; set; } = new();
    public RetrySettings Retry { get; set; } = new();
    public HedgingSettings Hedging { get; set; } = new();
    public CircuitBreakerSettings CircuitBreaker { get; set; } = new();
}

public sealed class FallbackSettings
{
    public bool Enabled { get; set; } = true;
    public string Message { get; set; } = "The service is temporarily unavailable. Please try again.";
}

/// <summary>Requests per time window (token bucket). Protects the downstream's quota.</summary>
public sealed class RateLimitSettings
{
    public bool Enabled { get; set; }
    public int TokenLimit { get; set; } = 100;
    public int TokensPerPeriod { get; set; } = 100;
    public TimeSpan ReplenishmentPeriod { get; set; } = TimeSpan.FromSeconds(1);
    public int QueueLimit { get; set; }
}

/// <summary>Requests in flight at once (concurrency limiter). Protects THIS process's resources.</summary>
public sealed class BulkheadSettings
{
    public bool Enabled { get; set; } = true;
    public int PermitLimit { get; set; } = 100;
    public int QueueLimit { get; set; }
}

public sealed class RetrySettings
{
    public int MaxRetryAttempts { get; set; } = 3;
    public TimeSpan BaseDelay { get; set; } = TimeSpan.FromMilliseconds(200);
    public TimeSpan MaxDelay { get; set; } = TimeSpan.FromSeconds(5);
    public bool UseJitter { get; set; } = true;
}

public sealed class HedgingSettings
{
    /// <summary>
    /// When true, the pipeline uses hedging INSTEAD of retry. Never both: hedging already
    /// re-issues on transient failures, so stacking them multiplies attempts.
    /// </summary>
    public bool UsePrecedence { get; set; }
    public int MaxHedgedAttempts { get; set; } = 1;

    /// <summary>Wait this long for the primary before firing a hedge. Set near your p90-p95 latency.</summary>
    public TimeSpan Delay { get; set; } = TimeSpan.FromSeconds(1);
}

public sealed class CircuitBreakerSettings
{
    public bool Enabled { get; set; } = true;
    public double FailureRatio { get; set; } = 0.1;
    public int MinimumThroughput { get; set; } = 100;
    public TimeSpan SamplingDuration { get; set; } = TimeSpan.FromSeconds(30);
    public TimeSpan BreakDuration { get; set; } = TimeSpan.FromSeconds(5);
}
