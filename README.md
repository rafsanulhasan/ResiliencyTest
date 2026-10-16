# ResiliencyTest

A runnable reference for adding resilience pipelines to `HttpClient` in .NET 10 with
`AddResilienceHandler` (Polly v8), tailored to an API that:

- uses only GET / POST / DELETE, and **POST for fetches** (filter, paging, sorting in the body)
- returns **200 for success and 400 for every failure**
- returns **not-found as 200** with `null` data and a message
- wraps every body in a `QueryResponse` / `CommandResponse` envelope

## Run it

```powershell
dotnet run --project src/ResiliencyTest.Demo              # all 19 scenarios
dotnet run --project src/ResiliencyTest.Demo -- hedging   # filter by id or tag
```

Tags: `retry`, `semantics`, `override`, `timeout`, `hedging`, `breaker`, `bulkhead`, `ratelimit`, `fallback`.

The demo starts the fake API in-process on `http://127.0.0.1:5199` (change it in
`src/ResiliencyTest.Demo/appsettings.json`), runs each scenario, and checks the result
against server-side hit counters, so every claim below is proved, not just printed.

## Projects

| Project | What it is |
|---|---|
| `ResiliencyTest.Contracts` | Envelopes (`QueryResponse<T>`, `CommandResponse`), `ErrorCategories`, header names |
| `ResiliencyTest.Resilience` | **The part to copy into your project**: options, pipeline, `ICustomHttpClient` |
| `ResiliencyTest.FlakyApi` | Fake service following the team's conventions, with failures injected via `X-Chaos-*` headers |
| `ResiliencyTest.Demo` | Registers six clients and runs the scenarios |

## The pipeline (outer to inner)

```
RequestSnapshotHandler          capture method/url/headers/body once
  ResilienceHandler (AddResilienceHandler)
    Fallback                    any final failure -> the team's 400 envelope + X-Resilience-Fallback
    Rate limiter                requests per second (token bucket)             [optional]
    Bulkhead                    requests in flight at once (concurrency limiter)
    Total timeout               the caller's whole budget
    Retry  OR  Hedging          chosen by Hedging.UsePrecedence, never both
    Circuit breaker             counts every attempt
    Attempt timeout             one try
  PerAttemptRequestHandler      a fresh HttpRequestMessage for every retry/hedge
```

See `Pipeline/CustomPipelineComposer.cs`; each strategy lives in `Pipeline/Strategies/`.

## Key design decisions

**Retry or hedging, chosen when the pipeline is built.** `AddResilienceHandler`'s callback runs when the
pipeline is built (and on config reload via `EnableReloads`), not per request, so a plain `if` works.

**Semantics, not HTTP methods, decide what is safe.** `DisableForUnsafeHttpMethods()` is deliberately not
used: it would stop retries on POST fetches. `SemanticsResolver` derives `Query` / `Command` /
`IdempotentCommand` from the envelope type you ask for (`SendAsync<QueryResponse<T>>` means Query),
the `Idempotency-Key`, then the method.

| | Query | IdempotentCommand | Command |
|---|---|---|---|
| Retry on infrastructure failure (5xx, timeout, connection) | yes | yes | only if it never reached the server |
| Retry on `400 + X-Error-Category: Transient` | yes | yes | yes (contract: nothing committed) |
| Hedge | yes | no | no |

**400 hides outages, so the server classifies failures.** `FailureClassifier` treats
`400 + X-Error-Category: Transient` as retryable and as a breaker failure. Validation 400s and
unclassified 400s are never retried and never open the circuit. This is the one server-side change
to push for, together with the promise that *Transient means nothing was committed*.

**Per-request overrides can only tighten.** `UnifiedHttpRequest.Resilience` travels in the Polly
`ResilienceContext` (`message.SetResilienceContext`) and is read by `ShouldHandle`, `TimeoutGenerator`,
`DelayGenerator` and `ActionGenerator`. Circuit breaker, bulkhead and rate limiter are shared state and
are not overridable.

**Request snapshot per attempt.** Inside a custom handler every retry and every parallel hedge receives
the *same* `HttpRequestMessage`. `AddStandardHedgingHandler` clones it internally; here
`RequestSnapshotHandler` + `PerAttemptRequestHandler` do the same, which is what makes hedging POST
searches safe.

**`HttpClient.Timeout` is infinite.** The pipeline owns every timeout.

## Gotcha found while building this

Several strategies (retry, breaker, fallback) inspect the same 400 body. Reading it with
`ReadFromJsonAsync` twice throws `ObjectDisposedException`: buffered `HttpContent` caches the stream it
hands out, and `ReadFromJsonAsync` disposes it. `FailureClassifier` buffers and reads the **bytes** instead.

## Scenarios

| Id | Shows |
|---|---|
| retry-transient400 | Transient 400 retried with exponential backoff + jitter |
| retry-validation400 | Validation 400 never retried |
| retry-unclassified400 | 400 without a category is not retried |
| not-found-200 | 200 + null is a valid answer |
| post-fetch-is-query | POST search retried because it returns `QueryResponse` |
| command-503-not-retried | Command + 503 not retried (unknown outcome), fallback returned |
| command-transient400-retried | Command + Transient 400 retried (server rolled back) |
| idempotent-command | Server commits then fails; retry is de-duplicated by `Idempotency-Key` |
| override-disable-retry | Per-request `DisableRetry` |
| override-attempt-timeout | Per-request shorter `AttemptTimeout` |
| override-disable-fallback | Per-request `DisableFallback` + `MaxRetryAttempts` |
| hedging-tail-latency | Hedge answers in ~200ms while the primary hangs for 1.5s |
| hedging-post-fetch | POST search hedged with its body intact |
| hedging-max-per-request | Per-request `MaxHedgedAttempts` |
| hedging-disabled-per-request | Per-request `DisableHedging` |
| hedging-never-hedges-commands | Commands are never hedged |
| circuit-breaker | Opens after 4 failures, short-circuits, half-open probe closes it |
| bulkhead | 3 in flight + 2 queued, 5 rejected immediately |
| rate-limit | Token bucket: 5 of a 12-call burst pass |
