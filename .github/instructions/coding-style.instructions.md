---
description: "C# coding style conventions"
applyTo: "**/*.cs"
---

# Coding Style

- Use explicit type declarations with target-typed `new` expressions or collection expressions.
  - Correct: `FileStream stream = new("path");` or `List<int> intList = [];`
  - Exception: `Stream stream = new FileStream("path")` — use explicit right-hand type when the declared type is an interface or base type.
  - Exception: `IEnumerable<T> items = new List<T>()` — use explicit right-hand type when upcasting to an interface.
- Prefer `await using` (async disposal) over `using` (sync disposal) when the type supports `IAsyncDisposable`.
- All API responses must use the `{ data, error }` return shape.
- Never expose stack traces to clients in API responses.
- Use the project logger module; never use `Console.Write*` or `console.log`.
