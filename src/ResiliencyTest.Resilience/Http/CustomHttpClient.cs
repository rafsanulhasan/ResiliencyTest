using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Polly;
using ResiliencyTest.Contracts;
using ResiliencyTest.Resilience.Pipeline;
using ResiliencyTest.Resilience.Requests;

namespace ResiliencyTest.Resilience.Http;

public interface ICustomHttpClient
{
    /// <summary>Raw response. Semantics come from the request (or the HTTP method).</summary>
    Task<HttpResponseMessage> SendAsync(UnifiedHttpRequest request, CancellationToken ct = default);

    /// <summary>
    /// Typed envelope. The envelope type also tells the pipeline what the call IS:
    /// QueryResponse => Query (so POST fetches become retryable/hedgeable), CommandResponse => Command.
    /// Never throws for HTTP failures; non-envelope responses (e.g. a gateway 503) are normalized.
    /// </summary>
    Task<TResponse> SendAsync<TResponse>(UnifiedHttpRequest request, CancellationToken ct = default)
        where TResponse : ResponseBase, new();
}

public sealed class CustomHttpClient(HttpClient http, ILogger<CustomHttpClient> logger) : ICustomHttpClient
{
    public Task<HttpResponseMessage> SendAsync(UnifiedHttpRequest request, CancellationToken ct = default) =>
        SendCoreAsync(request, SemanticsResolver.Resolve(request, responseType: null), ct);

    public async Task<TResponse> SendAsync<TResponse>(UnifiedHttpRequest request, CancellationToken ct = default)
        where TResponse : ResponseBase, new()
    {
        using var response = await SendCoreAsync(request, SemanticsResolver.Resolve(request, typeof(TResponse)), ct);
        return await ReadEnvelopeAsync<TResponse>(response, ct);
    }

    private async Task<HttpResponseMessage> SendCoreAsync(UnifiedHttpRequest request, RequestSemantics semantics, CancellationToken ct)
    {
        using var message = new HttpRequestMessage(request.Method, request.Path);
        if (request.Body is not null)
            message.Content = JsonContent.Create(request.Body, request.Body.GetType());
        foreach (var (name, value) in request.Headers)
            message.Headers.TryAddWithoutValidation(name, value);
        if (!string.IsNullOrWhiteSpace(request.IdempotencyKey))
            message.Headers.TryAddWithoutValidation(WireHeaders.IdempotencyKey, request.IdempotencyKey);

        // Per-request data for the (cached, shared) pipeline travels in the Polly context.
        var context = ResilienceContextPool.Shared.Get(ct);
        try
        {
            context.Properties.Set(CustomResilienceKeys.Semantics, semantics);
            if (request.Resilience is { } overrides)
                context.Properties.Set(CustomResilienceKeys.Overrides, overrides);

            message.SetResilienceContext(context); // the ResilienceHandler uses this context instead of a pooled one

            logger.LogDebug("{Method} {Path} as {Semantics}", request.Method, request.Path, semantics);
            return await http.SendAsync(message, ct);
        }
        finally
        {
            ResilienceContextPool.Shared.Return(context);
        }
    }

    private static async Task<TResponse> ReadEnvelopeAsync<TResponse>(HttpResponseMessage response, CancellationToken ct)
        where TResponse : ResponseBase, new()
    {
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (mediaType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
        {
            try
            {
                if (await response.Content.ReadFromJsonAsync<TResponse>(ct) is { } envelope) return envelope;
            }
            catch (JsonException)
            {
                // fall through: not our envelope
            }
        }

        // Not an envelope (gateway 503, HTML error page...): normalize into the team's failure shape.
        var transient = (int)response.StatusCode >= 500
                        || response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests;
        return new TResponse
        {
            IsSuccess = false,
            Message = $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}",
            ErrorCategory = transient ? ErrorCategories.Transient : ErrorCategories.Unknown
        };
    }
}

/// <summary>Decides what a call IS. The team's HTTP methods don't, so the envelope type does.</summary>
public static class SemanticsResolver
{
    public static RequestSemantics Resolve(UnifiedHttpRequest request, Type? responseType)
    {
        if (request.Semantics != RequestSemantics.Auto) return request.Semantics;               // explicit wins
        if (responseType is not null && typeof(QueryResponse).IsAssignableFrom(responseType))
            return RequestSemantics.Query;                                                     // POST fetch included
        if (!string.IsNullOrWhiteSpace(request.IdempotencyKey)) return RequestSemantics.IdempotentCommand;
        if (responseType is not null && typeof(CommandResponse).IsAssignableFrom(responseType))
            return RequestSemantics.Command;
        if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head || request.Method == HttpMethod.Options)
            return RequestSemantics.Query;                                                     // no mutating GETs
        return RequestSemantics.Command;                                                       // safe default
    }
}
