using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ResiliencyTest.Contracts;

namespace ResiliencyTest.FlakyApi;

/// <summary>
/// A stand-in for the team's services, following their conventions exactly:
///   only GET / POST / DELETE; fetches with filter/paging/sorting use POST;
///   200 for success, 400 for every failure; not-found = 200 with null data and a message;
///   every body is a QueryResponse / CommandResponse envelope.
/// Plus the one recommended change: X-Error-Category on failures.
/// Failures are injected on demand through the X-Chaos-* request headers.
/// </summary>
public static class FlakyApiServer
{
    public static async Task<WebApplication> StartAsync(string url, CancellationToken ct = default)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls(url);

        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss.fff "; });
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Logging.AddFilter("FlakyApi", LogLevel.Information);

        builder.Services.AddSingleton<ChaosState>();
        builder.Services.AddSingleton<OrderStore>();

        var app = builder.Build();
        app.UseMiddleware<ErrorEnvelopeMiddleware>(); // outermost: exceptions -> 400 envelope
        app.UseMiddleware<ChaosMiddleware>();
        MapEndpoints(app);

        await app.StartAsync(ct);
        return app;
    }

    private static void MapEndpoints(WebApplication app)
    {
        var products = Enumerable.Range(1, 25).Select(i => new Product(i, $"Product {i:00}", 10m + i)).ToArray();

        // GET by id. Not found is a 200 with null data and a message (team convention).
        app.MapGet("/products/{id:int}", (int id) =>
        {
            var product = products.FirstOrDefault(p => p.Id == id);
            return Results.Ok(new QueryResponse<Product>
            {
                IsSuccess = true,
                Data = product,
                Message = product is null ? $"Product {id} not found." : null
            });
        });

        // POST used as a fetch: filter, paging and sorting in the body.
        app.MapPost("/products/search", (ProductSearch search) =>
        {
            var query = products.Where(p => string.IsNullOrWhiteSpace(search.Term)
                                            || p.Name.Contains(search.Term, StringComparison.OrdinalIgnoreCase));
            query = (search.SortBy.ToLowerInvariant(), search.Descending) switch
            {
                ("price", false) => query.OrderBy(p => p.Price),
                ("price", true) => query.OrderByDescending(p => p.Price),
                (_, true) => query.OrderByDescending(p => p.Name),
                _ => query.OrderBy(p => p.Name)
            };
            var all = query.ToList();
            var page = all.Skip((search.Page - 1) * search.PageSize).Take(search.PageSize).ToList();
            return Results.Ok(new QueryResponse<PagedResult<Product>>
            {
                IsSuccess = true,
                Data = new PagedResult<Product>(page, search.Page, search.PageSize, all.Count) // empty list, not 404
            });
        });

        // Command. Honors Idempotency-Key. X-Chaos-After-Commit makes it fail AFTER committing,
        // which is exactly the "unknown outcome" case that makes retrying commands dangerous.
        app.MapPost("/orders", (CreateOrder command, HttpContext http, OrderStore store) =>
        {
            if (command.Quantity <= 0) throw new ValidationFailedException("Quantity must be greater than zero.");

            var (order, replayed) = store.Create(command, http.Request.Headers[WireHeaders.IdempotencyKey].ToString());

            if (ChaosMiddleware.ShouldFailAfterCommit(http))
                return Results.Text("Service Unavailable (simulated: failed AFTER commit)", "text/plain", statusCode: 503);

            return Results.Ok(new CommandResponse
            {
                IsSuccess = true,
                Id = order.Id,
                Message = replayed ? "Replayed: this Idempotency-Key was already processed." : "Created."
            });
        });

        app.MapGet("/orders/count", (OrderStore store) =>
            Results.Ok(new QueryResponse<int> { IsSuccess = true, Data = store.Count }));

        // Idempotent DELETE: deleting something already gone is still a success.
        app.MapDelete("/orders/{id}", (string id, OrderStore store) =>
            Results.Ok(new CommandResponse { IsSuccess = true, Id = id, Message = store.Delete(id) ? "Deleted." : "Already deleted." }));

        // Test hook: how many requests with this chaos key actually reached the server?
        app.MapGet("/chaos/hits/{key}", (string key, ChaosState state) => Results.Ok(state.Hits(key)));
    }
}
