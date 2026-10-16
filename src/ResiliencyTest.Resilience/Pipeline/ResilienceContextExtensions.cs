using Polly;
using ResiliencyTest.Resilience.Requests;

namespace ResiliencyTest.Resilience.Pipeline;

/// <summary>
/// The pipeline is built ONCE per client and cached. Per-request data reaches the strategies
/// through the Polly ResilienceContext, which CustomHttpClient attaches to each HttpRequestMessage.
/// </summary>
public static class CustomResilienceKeys
{
    public static readonly ResiliencePropertyKey<ResilienceOverrides> Overrides = new("custom.resilience.overrides");
    public static readonly ResiliencePropertyKey<RequestSemantics> Semantics = new("custom.resilience.semantics");

    /// <summary>Set by the bulkhead / rate limiter when they reject, so fallback can say which one did.</summary>
    public static readonly ResiliencePropertyKey<string> RejectedBy = new("custom.resilience.rejected-by");
}

public static class ResilienceContextExtensions
{
    public static ResilienceOverrides? GetOverrides(this ResilienceContext context) =>
        context.Properties.TryGetValue(CustomResilienceKeys.Overrides, out var value) ? value : null;

    /// <summary>Defaults to Command: if nobody told us otherwise, assume the call has side effects.</summary>
    public static RequestSemantics GetSemantics(this ResilienceContext context) =>
        context.Properties.GetValue(CustomResilienceKeys.Semantics, RequestSemantics.Command);

    /// <summary>A per-request value may lower the ceiling, never raise it.</summary>
    public static TimeSpan Tighten(TimeSpan? requested, TimeSpan ceiling) =>
        requested is { } r && r > TimeSpan.Zero && r < ceiling ? r : ceiling;
}
