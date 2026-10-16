namespace ResiliencyTest.Resilience.Requests;

/// <summary>
/// The request shape consumers hand to <see cref="Http.ICustomHttpClient"/>.
/// </summary>
public sealed class UnifiedHttpRequest
{
    public required HttpMethod Method { get; init; }

    /// <summary>Relative to the client's BaseAddress, query string included.</summary>
    public required string Path { get; init; }

    /// <summary>Serialized as JSON. Used for commands AND for POST-based fetches (filter/paging/sort).</summary>
    public object? Body { get; init; }

    public Dictionary<string, string> Headers { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// What the call IS, independent of the HTTP method. Leave as Auto and the client derives it
    /// from the envelope type (QueryResponse vs CommandResponse), the Idempotency-Key and the method.
    /// </summary>
    public RequestSemantics Semantics { get; init; } = RequestSemantics.Auto;

    /// <summary>Sent as the Idempotency-Key header; turns a Command into an IdempotentCommand.</summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>Per-request tweaks to the configured defaults. They can only tighten, never loosen.</summary>
    public ResilienceOverrides? Resilience { get; init; }
}

public enum RequestSemantics
{
    /// <summary>Infer it (see SemanticsResolver).</summary>
    Auto,

    /// <summary>Read-only. Safe to retry and to hedge. POST searches belong here.</summary>
    Query,

    /// <summary>Has side effects. Retried only when the request provably never reached the server,
    /// or when the server says Transient (= nothing committed). Never hedged.</summary>
    Command,

    /// <summary>A write the server de-duplicates (Idempotency-Key). Safe to retry, still never hedged.</summary>
    IdempotentCommand
}

/// <summary>
/// Per-request overrides. Each value can only make the policy STRICTER than appsettings:
/// fewer attempts, shorter timeouts, or a strategy switched off.
/// </summary>
public sealed record ResilienceOverrides
{
    public bool? DisableRetry { get; init; }
    public int? MaxRetryAttempts { get; init; }
    public bool? DisableHedging { get; init; }
    public int? MaxHedgedAttempts { get; init; }
    public TimeSpan? HedgingDelay { get; init; }
    public TimeSpan? AttemptTimeout { get; init; }
    public TimeSpan? TotalTimeout { get; init; }
    public bool? DisableFallback { get; init; }
}
