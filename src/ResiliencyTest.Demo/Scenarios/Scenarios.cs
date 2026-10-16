using ResiliencyTest.Contracts;
using ResiliencyTest.Resilience.Requests;
using static ResiliencyTest.Demo.Scenarios.Clients;

namespace ResiliencyTest.Demo.Scenarios;

public sealed partial class ScenarioRunner
{
    private static readonly HttpMethod Get = HttpMethod.Get;
    private static readonly HttpMethod Post = HttpMethod.Post;

    private static IEnumerable<Scenario> All() =>
    [
        // ---------------- Retry + the 200/400 convention ----------------
        new("retry-transient400", "Retry recovers a Transient 400",
            "Server fails twice with 400 + X-Error-Category: Transient (rolled back), then succeeds.",
            ["retry"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/1", ChaosModes.Transient400, failTimes: 2));
                ctx.Show("result", r);
                ctx.Expect("call succeeded", r.IsSuccess && r.Data?.Id == 1);
                ctx.Expect("3 attempts reached the server (1 + 2 retries)", await ctx.ServerHitsAsync() == 3);
            }),

        new("retry-validation400", "Validation 400 is never retried",
            "Bad input gives the same answer every time; retrying only adds load.",
            ["retry"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/1", ChaosModes.Validation400));
                ctx.Show("result", r);
                ctx.Expect("failure surfaced to the caller as Validation", !r.IsSuccess && r.ErrorCategory == ErrorCategories.Validation);
                ctx.Expect("exactly 1 attempt", await ctx.ServerHitsAsync() == 1);
            }),

        new("retry-unclassified400", "Unclassified 400 is not retried",
            "Without X-Error-Category the client cannot know it was transient, so it plays safe.",
            ["retry"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/1", ChaosModes.Unknown400, failTimes: 1));
                ctx.Show("result", r);
                ctx.Expect("failure surfaced, no fallback", !r.IsSuccess && r.Message?.StartsWith("[fallback") != true);
                ctx.Expect("exactly 1 attempt", await ctx.ServerHitsAsync() == 1);
            }),

        new("not-found-200", "Not-found (200 + null) is a valid answer",
            "Team convention: 200 with null data and a message. No retry, never counted by the breaker.",
            ["retry", "semantics"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(ctx.Request(Get, "/products/999"));
                ctx.Show("result", r);
                ctx.Expect("success with null data", r.IsSuccess && r.Data is null);
                ctx.Expect("exactly 1 attempt", await ctx.ServerHitsAsync() == 1);
            }),

        // ---------------- Semantics: POST fetch vs commands ----------------
        new("post-fetch-is-query", "POST search is retried (it is a Query)",
            "SendAsync<QueryResponse<...>> marks the call as Query, so a gateway 503 is retried despite POST.",
            ["semantics", "retry"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<PagedResult<Product>>>(
                    ctx.Request(Post, "/products/search", ChaosModes.Status503, failTimes: 2,
                        body: new ProductSearch("1", PageSize: 5, SortBy: "price", Descending: true)));
                ctx.Show("result", r);
                ctx.Expect("search succeeded with a page of results", r.IsSuccess && r.Data is { Items.Count: > 0 });
                ctx.Expect("3 attempts reached the server", await ctx.ServerHitsAsync() == 3);
            }),

        new("command-503-not-retried", "Command + 503 is NOT retried (unknown outcome)",
            "A 503/500/timeout on a command may already have committed. Retrying could create a duplicate.",
            ["semantics", "fallback"], async ctx =>
            {
                var before = await ctx.OrderCountAsync();
                var r = await ctx.Client(Orders).SendAsync<CommandResponse>(
                    ctx.Request(Post, "/orders", ChaosModes.Status503, failTimes: 1, body: new CreateOrder(1, 2)));
                ctx.Show("result", r);
                ctx.Expect("exactly 1 attempt", await ctx.ServerHitsAsync() == 1);
                ctx.Expect("caller got the fallback envelope", !r.IsSuccess && r.Message?.StartsWith("[fallback:http-503]") == true);
                ctx.Expect("no order created", await ctx.OrderCountAsync() == before);
            }),

        new("command-transient400-retried", "Command + Transient 400 IS retried",
            "Transient means the server rolled back: nothing committed, so even a command is safe to retry.",
            ["semantics", "retry"], async ctx =>
            {
                var before = await ctx.OrderCountAsync();
                var r = await ctx.Client(Orders).SendAsync<CommandResponse>(
                    ctx.Request(Post, "/orders", ChaosModes.Transient400, failTimes: 1, body: new CreateOrder(2, 1)));
                ctx.Show("result", r);
                ctx.Expect("order created", r.IsSuccess && r.Id is not null);
                ctx.Expect("2 attempts reached the server", await ctx.ServerHitsAsync() == 2);
                ctx.Expect("exactly one order created", await ctx.OrderCountAsync() == before + 1);
            }),

        new("idempotent-command", "Idempotency-Key makes a command safe to retry",
            "The server commits, THEN fails with 503. The retry carries the same key and is de-duplicated.",
            ["semantics", "retry"], async ctx =>
            {
                var before = await ctx.OrderCountAsync();
                var r = await ctx.Client(Orders).SendAsync<CommandResponse>(
                    ctx.Request(Post, "/orders", ChaosModes.Status503, failTimes: 1, afterCommit: true,
                        idempotencyKey: Guid.NewGuid().ToString(), body: new CreateOrder(3, 4)));
                ctx.Show("result", r);
                ctx.Expect("retry returned the replayed order", r.IsSuccess && r.Message?.StartsWith("Replayed") == true);
                ctx.Expect("2 attempts reached the server", await ctx.ServerHitsAsync() == 2);
                ctx.Expect("exactly one order exists (no duplicate)", await ctx.OrderCountAsync() == before + 1);
            }),

        // ---------------- Per-request overrides ----------------
        new("override-disable-retry", "Per-request: DisableRetry",
            "Same Transient 400 as the first scenario, but this caller opts out of retries.",
            ["override", "fallback"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/1", ChaosModes.Transient400, failTimes: 1,
                        overrides: new ResilienceOverrides { DisableRetry = true }));
                ctx.Show("result", r);
                ctx.Expect("exactly 1 attempt", await ctx.ServerHitsAsync() == 1);
                ctx.Expect("fallback envelope returned", r.Message?.StartsWith("[fallback:http-400]") == true);
            }),

        new("override-attempt-timeout", "Per-request: shorter AttemptTimeout",
            "First hit takes 1500ms. Config allows 2s per attempt; this caller allows 300ms, times out, retries fast.",
            ["override", "timeout"], async ctx =>
            {
                var (r, elapsed) = await ScenarioContext.TimeAsync(() => ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/2", ChaosModes.SlowFirst, delayMs: 1500,
                        overrides: new ResilienceOverrides { AttemptTimeout = TimeSpan.FromMilliseconds(300) })));
                ctx.Show($"result after {elapsed.TotalMilliseconds:N0}ms", r);
                ctx.Expect("succeeded", r.IsSuccess);
                ctx.Expect("2 attempts reached the server", await ctx.ServerHitsAsync() == 2);
                ctx.Expect("finished well before the slow attempt would have (< 1200ms)", elapsed < TimeSpan.FromMilliseconds(1200));
            }),

        new("override-disable-fallback", "Per-request: DisableFallback + MaxRetryAttempts = 1",
            "Gateway keeps returning 503. This caller wants the real error, and only one retry.",
            ["override", "fallback"], async ctx =>
            {
                var r = await ctx.Client(Catalog).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/3", ChaosModes.Status503,
                        overrides: new ResilienceOverrides { DisableFallback = true, MaxRetryAttempts = 1 }));
                ctx.Show("result", r);
                ctx.Expect("2 attempts (1 + 1 retry), not the configured 4", await ctx.ServerHitsAsync() == 2);
                ctx.Expect("real HTTP 503 surfaced, no fallback", !r.IsSuccess && r.Message?.StartsWith("HTTP 503") == true);
            }),

        // ---------------- Hedging (Search client: UsePrecedence = true) ----------------
        new("hedging-tail-latency", "Hedging beats a slow primary",
            "Primary hangs for 1500ms. After 200ms a hedge fires, answers fast, and the primary is cancelled.",
            ["hedging"], async ctx =>
            {
                var (r, elapsed) = await ScenarioContext.TimeAsync(() => ctx.Client(Search).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/4", ChaosModes.SlowFirst, delayMs: 1500)));
                ctx.Show($"result after {elapsed.TotalMilliseconds:N0}ms", r);
                ctx.Expect("succeeded", r.IsSuccess);
                ctx.Expect("answered in well under the 1500ms primary (< 900ms)", elapsed < TimeSpan.FromMilliseconds(900));
                ctx.Expect("2 requests reached the server (primary + 1 hedge)", await ctx.ServerHitsAsync() == 2);
            }),

        new("hedging-post-fetch", "POST search is hedged too",
            "Each hedge is rebuilt from a request snapshot, so the JSON body is sent intact by every attempt.",
            ["hedging", "semantics"], async ctx =>
            {
                var (r, elapsed) = await ScenarioContext.TimeAsync(() => ctx.Client(Search).SendAsync<QueryResponse<PagedResult<Product>>>(
                    ctx.Request(Post, "/products/search", ChaosModes.SlowFirst, delayMs: 1500, body: new ProductSearch("2"))));
                ctx.Show($"result after {elapsed.TotalMilliseconds:N0}ms", r);
                ctx.Expect("search succeeded with results", r.IsSuccess && r.Data is { Items.Count: > 0 });
                ctx.Expect("answered fast (< 900ms)", elapsed < TimeSpan.FromMilliseconds(900));
            }),

        new("hedging-max-per-request", "Per-request: fewer hedges than configured",
            "Every attempt is slow. Config allows 2 hedges (3 requests); this caller allows only 1 (2 requests).",
            ["hedging", "override"], async ctx =>
            {
                var r = await ctx.Client(Search).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/9", ChaosModes.Slow, delayMs: 700,
                        overrides: new ResilienceOverrides { MaxHedgedAttempts = 1 }));
                var withOverride = await ctx.ServerHitsAsync();

                var baselineKey = ctx.Key + "-base";
                await ctx.Client(Search).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/9", ChaosModes.Slow, delayMs: 700, key: baselineKey));
                var baseline = await ctx.ServerHitsAsync(baselineKey);

                ctx.Show("result", r);
                ctx.Expect($"configured: primary + 2 hedges = 3 requests (got {baseline})", baseline == 3);
                ctx.Expect($"override: primary + 1 hedge = 2 requests (got {withOverride})", withOverride == 2);
            }),

        new("hedging-disabled-per-request", "Per-request: DisableHedging",
            "Same slow primary, but this caller opts out. It waits the full 800ms with a single request.",
            ["hedging", "override"], async ctx =>
            {
                var (r, elapsed) = await ScenarioContext.TimeAsync(() => ctx.Client(Search).SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/5", ChaosModes.SlowFirst, delayMs: 800,
                        overrides: new ResilienceOverrides { DisableHedging = true })));
                ctx.Show($"result after {elapsed.TotalMilliseconds:N0}ms", r);
                ctx.Expect("succeeded", r.IsSuccess);
                ctx.Expect("exactly 1 request", await ctx.ServerHitsAsync() == 1);
                ctx.Expect("took the full slow path (>= 750ms)", elapsed >= TimeSpan.FromMilliseconds(750));
            }),

        new("hedging-never-hedges-commands", "Commands are never hedged",
            "A slow POST /orders through the hedging client. Duplicated in-flight writes are never acceptable.",
            ["hedging", "semantics"], async ctx =>
            {
                var r = await ctx.Client(Search).SendAsync<CommandResponse>(
                    ctx.Request(Post, "/orders", ChaosModes.SlowFirst, delayMs: 800, body: new CreateOrder(5, 1)));
                ctx.Show("result", r);
                ctx.Expect("succeeded", r.IsSuccess);
                ctx.Expect("exactly 1 request (no hedge)", await ctx.ServerHitsAsync() == 1);
            }),

        // ---------------- Circuit breaker (Inventory: 50% of >= 4 calls in 10s, break 2s) ----------------
        new("circuit-breaker", "Circuit opens, short-circuits, then recovers",
            "Dependency is down (503). After 4 failed attempts the circuit opens; calls stop reaching it.",
            ["breaker", "fallback"], async ctx =>
            {
                var client = ctx.Client(Inventory);
                var results = new List<QueryResponse<Product>>();
                for (var i = 0; i < 6; i++)
                    results.Add(await client.SendAsync<QueryResponse<Product>>(
                        ctx.Request(Get, "/products/6", ChaosModes.Status503)));

                ctx.Show("call 1", results[0]);
                ctx.Show("call 6", results[5]);
                var hitsWhileDown = await ctx.ServerHitsAsync();
                ctx.Expect($"only 4 attempts reached the dead dependency (got {hitsWhileDown})", hitsWhileDown == 4);
                ctx.Expect("calls 3-6 were short-circuited", results.Skip(2).All(r => r.Message?.StartsWith("[fallback:circuit-open]") == true));

                Console.WriteLine("    ...waiting 2.2s for the break duration to pass");
                await Task.Delay(TimeSpan.FromMilliseconds(2200));

                var healthyKey = ctx.Key + "-ok";
                var probe = await client.SendAsync<QueryResponse<Product>>(ctx.Request(Get, "/products/6", key: healthyKey));
                ctx.Show("probe after recovery", probe);
                ctx.Expect("half-open probe succeeded, circuit closed", probe.IsSuccess);
            }),

        // ---------------- Bulkhead (Reports: 3 in flight + 2 queued) ----------------
        new("bulkhead", "Bulkhead caps concurrent calls",
            "10 parallel calls to a dependency that takes 1s. 3 run, 2 wait in the queue, 5 are rejected at once.",
            ["bulkhead", "fallback"], async ctx =>
            {
                var client = ctx.Client(Reports);
                var calls = Enumerable.Range(0, 10).Select(_ => client.SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/7", ChaosModes.Slow, delayMs: 1000)));
                var results = await Task.WhenAll(calls);

                var ok = results.Count(r => r.IsSuccess);
                var rejected = results.Count(r => r.Message?.StartsWith("[fallback:bulkhead-full]") == true);
                Console.WriteLine($"    succeeded={ok}, rejected={rejected}");
                ctx.Expect("5 succeeded (3 permits + 2 queued)", ok == 5);
                ctx.Expect("5 rejected by the bulkhead", rejected == 5);
                ctx.Expect("rejected calls never reached the server (5 hits)", await ctx.ServerHitsAsync() == 5);
            }),

        // ---------------- Rate limiting (Payments: token bucket 5/s, no queue) ----------------
        new("rate-limit", "Rate limiter enforces requests per second",
            "Burst of 12 fast calls against a 5-per-second quota. Latency is irrelevant; the count is what matters.",
            ["ratelimit", "fallback"], async ctx =>
            {
                var client = ctx.Client(Payments);
                var calls = Enumerable.Range(0, 12).Select(_ => client.SendAsync<QueryResponse<Product>>(
                    ctx.Request(Get, "/products/8")));
                var results = await Task.WhenAll(calls);

                var ok = results.Count(r => r.IsSuccess);
                var limited = results.Count(r => r.Message?.StartsWith("[fallback:rate-limited]") == true);
                Console.WriteLine($"    succeeded={ok}, rate-limited={limited}");
                ctx.Expect("about 5 succeeded (the bucket size)", ok is >= 5 and <= 6);
                ctx.Expect("the rest were rate-limited", ok + limited == 12);
            }),
    ];
}
