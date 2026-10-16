---
description: GlobalUsings.cs convention for C# projects
paths: ["**/*.cs"]
---

# GlobalUsings Convention

`GlobalUsings.cs` is per-C#-project. The convention is conditional, not mandatory for every project:

- When a C# project repeats the same `using` directive across multiple files, consolidate those shared imports into a single `GlobalUsings.cs` at that project's root.
- If the project has no `GlobalUsings.cs`, create one at the project root.
- Only promote a `using` to global when it is broadly used across the project; do not move project-specific or single-file usings.
- Scope is the individual project — adding a global using to one project does not affect any other project.

## Existing project convention

Non-shipping projects (test and sample projects) carry `[assembly: ExcludeFromCodeCoverage]` in their `GlobalUsings.cs`; never remove it. Do NOT add that attribute to `src/` production assemblies.

## Example

```csharp
// <ProjectRoot>/GlobalUsings.cs
global using System.Text.Json;
global using TUnit.Assertions.Should;
global using TUnit.Assertions.Should.Extensions;

// non-shipping (test/sample) projects only:
[assembly: ExcludeFromCodeCoverage]
```
