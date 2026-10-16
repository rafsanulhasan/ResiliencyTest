using System.Globalization;
using ResiliencyTest.Contracts;

namespace ResiliencyTest.Resilience.Http;

/// <summary>
/// Why this exists: inside AddResilienceHandler, every retry AND every parallel hedge passes the SAME
/// HttpRequestMessage down the chain. Hedging would send one message object concurrently, and a
/// non-buffered body could only be read once. AddStandardHedgingHandler solves this internally;
/// with a custom handler we do it ourselves: capture once (outermost), rebuild per attempt (innermost).
/// </summary>
public sealed class RequestSnapshot
{
    public static readonly HttpRequestOptionsKey<RequestSnapshot> OptionKey = new("custom.request.snapshot");

    private readonly HttpMethod _method;
    private readonly Uri? _uri;
    private readonly Version _version;
    private readonly HttpVersionPolicy _versionPolicy;
    private readonly KeyValuePair<string, string[]>[] _headers;
    private readonly byte[]? _content;
    private readonly KeyValuePair<string, string[]>[] _contentHeaders;
    private int _attempts;

    private RequestSnapshot(HttpRequestMessage request, byte[]? content)
    {
        _method = request.Method;
        _uri = request.RequestUri;
        _version = request.Version;
        _versionPolicy = request.VersionPolicy;
        _headers = [.. request.Headers.Select(h => KeyValuePair.Create(h.Key, h.Value.ToArray()))];
        _content = content;
        _contentHeaders = request.Content is null
            ? []
            : [.. request.Content.Headers.Select(h => KeyValuePair.Create(h.Key, h.Value.ToArray()))];
    }

    public static async Task<RequestSnapshot> CaptureAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var content = request.Content is null ? null : await request.Content.ReadAsByteArrayAsync(ct);
        return new RequestSnapshot(request, content);
    }

    /// <summary>A brand-new message for one attempt. Thread-safe, so parallel hedges are fine.</summary>
    public HttpRequestMessage CreateAttempt()
    {
        var attempt = Interlocked.Increment(ref _attempts);
        var message = new HttpRequestMessage(_method, _uri) { Version = _version, VersionPolicy = _versionPolicy };

        foreach (var (name, values) in _headers)
            message.Headers.TryAddWithoutValidation(name, values);
        message.Headers.TryAddWithoutValidation(WireHeaders.ClientAttempt, attempt.ToString(CultureInfo.InvariantCulture));

        if (_content is not null)
        {
            var content = new ByteArrayContent(_content);
            foreach (var (name, values) in _contentHeaders)
                content.Headers.TryAddWithoutValidation(name, values);
            message.Content = content;
        }

        return message;
    }
}

/// <summary>OUTERMOST handler: snapshot the logical request once, before the resilience pipeline.</summary>
public sealed class RequestSnapshotHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        request.Options.Set(RequestSnapshot.OptionKey, await RequestSnapshot.CaptureAsync(request, cancellationToken));
        return await base.SendAsync(request, cancellationToken);
    }
}

/// <summary>INNERMOST handler: each attempt (retry or hedge) goes out as its own fresh message.</summary>
public sealed class PerAttemptRequestHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        request.Options.TryGetValue(RequestSnapshot.OptionKey, out var snapshot)
            ? base.SendAsync(snapshot.CreateAttempt(), cancellationToken)
            : base.SendAsync(request, cancellationToken);
}
