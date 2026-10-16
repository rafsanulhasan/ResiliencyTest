---
name: team-roster
description: The team's agent IDs and the names they answer to in this repository
type: project
---

Team roster for ResiliencyTest, chosen at `/ai-dlc:init`. Every agent keeps its default name: no renames were requested.

| Agent ID | Name |
|---|---|
| agent-manager | Boris Cherny |
| brutal-critique | Linus Torvalds |
| code-reviewer | Robert C. Martin |
| devops-engineer | Gene Kim |
| documentation-writer | Daniele Procida |
| orchestrator | Scott Hanselman |
| presentation-manager | Nancy Duarte |
| product-manager | James Montemagno |
| product-owner | James Montemagno |
| requirement-analyst | James Montemagno |
| research-assistant | Jon Skeet |
| software-architect | Mark Richards |
| software-engineer | David Fowler |
| sqa-engineer | Kent Beck |
| system-engineer | Zoran Horvat |

Every agent also stays addressable by its role: the agent ID, or a role alias from the orchestrator's "Addressing agents by name or role" table.

**Why:** the developer kept the default names at `/ai-dlc:init`. Three agents share the name James Montemagno (product-owner, product-manager, requirement-analyst), so addressing that name is ambiguous; the orchestrator asks which one is meant.

**How to apply:** address agents by name or role using this table. Renames go through `agent-manager`, which updates this file and each renamed agent's `persona-name` memory together.
