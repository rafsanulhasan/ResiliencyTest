using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ResiliencyTest.Resilience.Http;
using ResiliencyTest.Resilience.Options;
using ResiliencyTest.Resilience.Pipeline;

namespace ResiliencyTest.Resilience.DependencyInjection;

public static class CustomHttpClientServiceCollectionExtensions
{
    /// <summary>
    /// Registers one downstream dependency: options from "Resilience:{name}", a named HttpClient with
    /// its own pipeline (its own breaker, bulkhead, limiter = isolation), and a keyed ICustomHttpClient.
    ///
    /// Handler chain (outer to inner):
    ///   RequestSnapshotHandler  ->  ResilienceHandler (the pipeline)  ->  PerAttemptRequestHandler  ->  network
    /// </summary>
    public static IHttpClientBuilder AddCustomHttpClient(this IServiceCollection services, string name, IConfiguration configuration)
    {
        services.AddOptions<CustomResilienceOptions>(name)
            .Bind(configuration.GetSection($"{CustomResilienceOptions.SectionRoot}:{name}"))
            .Validate(o => Uri.TryCreate(o.BaseAddress, UriKind.Absolute, out _), "BaseAddress must be an absolute URI.")
            .Validate(o => o.AttemptTimeout < o.TotalTimeout, "AttemptTimeout must be smaller than TotalTimeout.")
            .ValidateOnStart();

        services.TryAddTransient<RequestSnapshotHandler>();
        services.TryAddTransient<PerAttemptRequestHandler>();

        var builder = services.AddHttpClient(name, (sp, http) =>
        {
            var options = sp.GetRequiredService<IOptionsMonitor<CustomResilienceOptions>>().Get(name);
            http.BaseAddress = new Uri(options.BaseAddress);
            http.Timeout = Timeout.InfiniteTimeSpan; // the pipeline owns every timeout, not HttpClient's 100s default
        });

        builder.AddHttpMessageHandler<RequestSnapshotHandler>();

        builder.AddResilienceHandler($"{name}-pipeline", (pipeline, context) =>
        {
            var options = context.ServiceProvider.GetRequiredService<IOptionsMonitor<CustomResilienceOptions>>().Get(name);

            // Rebuild the pipeline when appsettings changes (e.g. flip Hedging.UsePrecedence at runtime).
            // Note: a rebuild also resets circuit breaker state.
            context.EnableReloads<CustomResilienceOptions>(name);

            var logger = context.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger($"Resilience.{name}");
            CustomPipelineComposer.Compose(pipeline, options, logger, context);
        });

        builder.AddHttpMessageHandler<PerAttemptRequestHandler>();

        services.AddKeyedTransient<ICustomHttpClient>(name, (sp, _) => new CustomHttpClient(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(name),
            sp.GetRequiredService<ILogger<CustomHttpClient>>()));

        return builder;
    }
}
