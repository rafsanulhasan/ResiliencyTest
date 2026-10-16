namespace ResiliencyTest.Contracts;

public sealed record Product(int Id, string Name, decimal Price);

/// <summary>POST-based fetch: filter, paging and sorting travel in the body.</summary>
public sealed record ProductSearch(string? Term, int Page = 1, int PageSize = 10, string SortBy = "name", bool Descending = false);

public sealed record PagedResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total);

public sealed record CreateOrder(int ProductId, int Quantity);

public sealed record Order(string Id, int ProductId, int Quantity, DateTimeOffset CreatedAt);

/// <summary>
/// Request headers the FlakyApi understands, so the demo can inject failures deterministically.
/// Hits are counted per <see cref="Key"/>, which lets the demo prove how many attempts reached the server.
/// </summary>
public static class ChaosHeaders
{
    public const string Key = "X-Chaos-Key";
    public const string Mode = "X-Chaos-Mode";
    public const string FailTimes = "X-Chaos-Fail-Times";
    public const string DelayMs = "X-Chaos-Delay-Ms";
    public const string AfterCommit = "X-Chaos-After-Commit";
}

public static class ChaosModes
{
    public const string None = "none";

    /// <summary>400 + X-Error-Category: Transient (server rolled back; safe to retry).</summary>
    public const string Transient400 = "transient400";

    /// <summary>400 + X-Error-Category: Validation (never retry).</summary>
    public const string Validation400 = "validation400";

    /// <summary>400 with no category, like an unclassified global exception handler.</summary>
    public const string Unknown400 = "unknown400";

    /// <summary>Plain 503, as a gateway/load balancer would return it.</summary>
    public const string Status503 = "status503";

    /// <summary>Delay every hit by X-Chaos-Delay-Ms.</summary>
    public const string Slow = "slow";

    /// <summary>Delay only the first hit for this key (tail latency, ideal for hedging).</summary>
    public const string SlowFirst = "slow-first";
}
