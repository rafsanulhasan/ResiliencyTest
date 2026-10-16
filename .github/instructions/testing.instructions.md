---
description: "Testing and quality gate requirements"
applyTo: "**"
---

# Testing Requirements

- After implementing every feature or fix, run `dotnet test` to validate all tests pass.
- After all tests pass, run `dotnet stryker` to run mutation tests and verify code quality.
- Never skip either quality gate before finishing.

## Exception For Non-Functional Artifact Changes

- If a change is non-functional and only updates agent artifacts, you may skip `dotnet test` and `dotnet stryker`.
- Non-functional agent artifacts include:
	- planning updates
	- agent definitions
	- skills
	- hooks
	- prompts or commands
	- rules or instructions
- If any production code, test code, runtime configuration, or build logic changes, run both quality gates.
