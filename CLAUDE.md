# CLAUDE.md

<!-- ai-dlc:begin pointer -->
@AGENTS.md

> Agent orchestration, routing, gates and memory rules live in [AGENTS.md](AGENTS.md), imported above. Claude Code reads `AGENTS.md` on its own only when there is no `CLAUDE.md`, so the import is what loads it here.
<!-- ai-dlc:end pointer -->

Reference implementation of HttpClient resilience pipelines in .NET 10 (`Microsoft.Extensions.Http.Resilience` /
Polly v8, via `AddResilienceHandler`), built to be ported into a work project whose API does not follow REST.
`src/ResiliencyTest.Resilience` is the part that gets copied; everything else exists to prove it works.

## Commands

```powershell
dotnet build                                                  # must stay at 0 warnings
dotnet run --project src/ResiliencyTest.Demo                  # all scenarios; exit code 0 = all passed
dotnet run --project src/ResiliencyTest.Demo -- <id-or-tag>   # e.g. hedging, breaker, retry-transient400
```

`global.json` pins SDK 10.0.401 (the machine also has .NET 11 RCs). The demo hosts the fake API in-process on
`http://127.0.0.1:5199` (`src/ResiliencyTest.Demo/appsettings.json`).

**Definition of done for any change:** build clean, and every demo scenario passes. Scenarios assert against
server-side hit counters (`GET /chaos/hits/{key}`), so they prove attempt counts instead of just printing.

## Layout

| Path | Purpose |
|---|---|
| `src/ResiliencyTest.Contracts` | `QueryResponse<T>`, `CommandResponse`, `ErrorEnvelope`, `ErrorCategories`, `WireHeaders`, chaos header names |
| `src/ResiliencyTest.Resilience/Options` | `CustomResilienceOptions`, bound per client from `Resilience:{ClientName}` |
| `src/ResiliencyTest.Resilience/Pipeline/CustomPipelineComposer.cs` | Builds the pipeline; the strategy order lives here |
| `src/ResiliencyTest.Resilience/Pipeline/Strategies/` | One file per strategy |
| `src/ResiliencyTest.Resilience/Pipeline/FailureClassifier.cs` | Transient-400 detection, "never reached server" detection |
| `src/ResiliencyTest.Resilience/Http/` | `ICustomHttpClient`, `SemanticsResolver`, request snapshot handlers |
| `src/ResiliencyTest.Resilience/DependencyInjection/` | `AddCustomHttpClient(name, config)` registers one isolated dependency |
| `src/ResiliencyTest.FlakyApi` | Fake service with the team's conventions; failures injected via `X-Chaos-*` headers |
| `src/ResiliencyTest.Demo/Scenarios/` | Self-checking scenarios (`Scenarios.cs`) and the runner |

## The target API's conventions (do not "fix" these; design around them)

- Only GET, POST, DELETE. No PUT/PATCH. **POST is also used for fetches** (filter, paging, sorting in the body).
- GETs never mutate.
- **200 for success, 400 for every failure.** Not-found is **200 with `null` data and a message**; empty lists are 200.
- Every body is a `QueryResponse` / `CommandResponse` envelope.
- The one server-side change we push for: failures carry `X-Error-Category` (`Transient` | `Validation` | `Conflict`),
  and **`Transient` guarantees nothing was committed**.

## Pipeline (outer to inner) — keep this order

```
RequestSnapshotHandler        capture the request once
  ResilienceHandler
    Fallback                  outermost; returns the team's 400 envelope + X-Resilience-Fallback header
    Rate limiter              token bucket, requests per window (optional, per client)
    Bulkhead                  concurrency limiter = Polly v8's bulkhead
    Total timeout
    Retry OR Hedging          chosen by Hedging.UsePrecedence at build time, NEVER both
    Circuit breaker           inside retry/hedging so every attempt counts
    Attempt timeout           innermost
  PerAttemptRequestHandler    fresh HttpRequestMessage per retry/hedge
```

## Rules

- **Never use `DisableForUnsafeHttpMethods()`.** Safety comes from `RequestSemantics`, not the HTTP method.
  `SemanticsResolver` order: explicit value > `QueryResponse` type => Query > `Idempotency-Key` => IdempotentCommand >
  `CommandResponse` => Command > GET/HEAD/OPTIONS => Query > default Command.
- Retry: Transient 400 => retry for all semantics. Infrastructure failure (5xx, 408, 429, timeout, connection) =>
  retry Query and IdempotentCommand; retry Command **only** if it never reached the server (DNS/connect/TLS errors).
- Validation and unclassified 400s are never retried and never count toward the circuit breaker.
- **Only Queries are hedged.** Not even idempotent commands (concurrent duplicates race in server-side dedupe).
- Per-request `ResilienceOverrides` travel in the Polly `ResilienceContext` (`message.SetResilienceContext`) and are
  read by `ShouldHandle` / `TimeoutGenerator` / `DelayGenerator` / `ActionGenerator`. They may **only tighten**
  (fewer attempts, shorter timeouts, strategy off, later hedge). Breaker, bulkhead and rate limiter are shared
  state: never per-request.
- `HttpClient.Timeout` is infinite; the pipeline owns all timeouts. `AttemptTimeout < TotalTimeout` is validated.
- One resilience handler per client. Do not stack `AddStandard*Handler` on top.
- The fallback response must stay in the envelope shape and be tagged, so it never looks like a healthy call.

## Gotchas (learned the hard way)

- Don't read a response body with `ReadFromJsonAsync` more than once. Buffered `HttpContent` caches the stream it
  hands out and `ReadFromJsonAsync` disposes it, so retry/breaker/fallback inspecting the same 400 hit
  `ObjectDisposedException`. `FailureClassifier` buffers and reads **bytes**.
- Inside `AddResilienceHandler`, every retry and parallel hedge gets the **same** `HttpRequestMessage`
  (`AddStandardHedgingHandler` clones internally; we don't use it). That's what the snapshot handlers fix.
- Hedging `ActionGenerator`'s `AttemptNumber` is 1 for the first hedge; `OnHedging`'s is 0-based.
- `EnableReloads` rebuilds the pipeline on config change, which also resets circuit-breaker state.
- On this Windows machine PowerShell blocks `.ps1` shims; use `claude.cmd` / `npm.cmd` rather than changing the
  execution policy.

## Adding a scenario

Add an entry in `Scenarios.cs` using `ctx.Request(...)` with a chaos mode (`ChaosModes.*`), then assert with
`ctx.Expect(...)` on the envelope **and** on `await ctx.ServerHitsAsync()`. Use a dedicated client in
`appsettings.json` when a scenario needs shared state (breaker, bulkhead, limiter) that would bleed into others.

<!-- ai-dlc:begin workspace-folders -->
## Workspace folders (Claude Code only)

- Write scratch files to `.scratch/<session-or-task>/` instead of Claude Code's built-in per-session scratchpad directory or the system temp directory.
- `claude --worktree`, `EnterWorktree` and agents with `isolation: "worktree"` get their worktree under `.worktrees/` through the `WorktreeCreate` hook in `.claude/settings.json`. Claude Code keeps the worktrees it creates for subagents; remove each with `git worktree remove` once its branch is merged.
<!-- ai-dlc:end workspace-folders -->
