namespace ResiliencyTest.Contracts;

/// <summary>
/// Mirrors the team's convention: every response (200 or 400) is wrapped in an envelope.
/// Success = 200, any failure = 400. "Not found" is a 200 with null data and a message.
/// </summary>
public abstract class ResponseBase
{
    public bool IsSuccess { get; init; }
    public string? Message { get; init; }

    /// <summary>
    /// The one addition the team needs on the server side: a machine-readable failure category.
    /// See <see cref="ErrorCategories"/>. Also sent as the <see cref="WireHeaders.ErrorCategory"/> header.
    /// </summary>
    public string? ErrorCategory { get; init; }
}

/// <summary>Non-generic marker so the client can detect "this call is a query" from the response type.</summary>
public abstract class QueryResponse : ResponseBase;

public sealed class QueryResponse<T> : QueryResponse
{
    public T? Data { get; init; }
}

public class CommandResponse : ResponseBase
{
    public string? Id { get; init; }
}

/// <summary>Shape every failure body shares, regardless of Query/Command.</summary>
public sealed class ErrorEnvelope : ResponseBase;

public static class ErrorCategories
{
    /// <summary>Bad input or a business rule. Retrying gives the same answer.</summary>
    public const string Validation = "Validation";

    /// <summary>Conflict with current state (duplicate, version mismatch).</summary>
    public const string Conflict = "Conflict";

    /// <summary>
    /// Temporary server-side failure (DB timeout, deadlock, downstream outage).
    /// Contract: NOTHING was committed, so the client may safely retry, even a command.
    /// </summary>
    public const string Transient = "Transient";

    /// <summary>Anything the server did not classify. Treated as non-retryable.</summary>
    public const string Unknown = "Unknown";
}

public static class WireHeaders
{
    public const string ErrorCategory = "X-Error-Category";
    public const string IdempotencyKey = "Idempotency-Key";
    public const string ResilienceFallback = "X-Resilience-Fallback";
    public const string ClientAttempt = "X-Client-Attempt";
}
