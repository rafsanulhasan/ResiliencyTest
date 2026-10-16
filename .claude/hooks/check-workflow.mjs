#!/usr/bin/env node
// check-workflow.mjs — AI-DLC workflow gate (Claude Code "Stop" / Copilot "agentStop" hook).
// Installed into a repository by the ai-dlc `workflow` skill (install, upgrade) and by /ai-dlc:init.
// Blocks the agent from finishing (once per stop cycle) while .ai-dlc/ has uncommitted changes and
// `node .ai-dlc/workflow.mjs validate` fails, so an invalid workflow file never reaches a commit.
// Silent when nothing under .ai-dlc/ changed, outside a git repository, when the workflow file was
// removed (the plugin default then applies), after one block in the same stop cycle, or when
// AI_DLC_WORKFLOW_GATE is false, 0, no or off.
// Dependency-free; runs on Windows, macOS and Linux with Node.js 18 or later.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const block = (reason) => {
  // Top-level decision/reason is the Stop-hook contract for Claude Code and the
  // agentStop decision-control contract for Copilot.
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
};

let payload = null;
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) payload = JSON.parse(raw);
} catch {
  payload = null;
}

// Loop guard: if we are already continuing because of a stop hook, let it pass.
if (payload && (payload.stop_hook_active === true || payload.stopHookActive === true)) process.exit(0);
if (["false", "0", "no", "off"].includes((process.env.AI_DLC_WORKFLOW_GATE ?? "").toLowerCase())) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, encoding: "utf8", windowsHide: true });
if (top.status !== 0 || !top.stdout.trim()) process.exit(0);
const root = path.resolve(top.stdout.trim());

const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", ".ai-dlc"], {
  encoding: "utf8",
  windowsHide: true,
});
if (status.status !== 0 || !status.stdout.trim()) process.exit(0); // nothing under .ai-dlc/ changed

const cli = path.join(root, ".ai-dlc", "workflow.mjs");
if (!existsSync(path.join(root, ".ai-dlc", "workflow.json"))) process.exit(0);
if (!existsSync(cli)) block("`.ai-dlc/workflow.json` changed but `.ai-dlc/workflow.mjs` is missing, so it cannot be validated. Run /ai-dlc:workflow install, then `node .ai-dlc/workflow.mjs validate`.");

const r = spawnSync(process.execPath, [cli, "validate"], { cwd: root, encoding: "utf8", windowsHide: true });
if (r.status === 0) process.exit(0);

const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim()).slice(-40).join("\n");
block(`The AI-DLC workflow in .ai-dlc/ is invalid (\`node .ai-dlc/workflow.mjs validate\` exit ${r.status ?? r.signal}). Fix every error before finishing — changes go through /ai-dlc:workflow edit (agent-manager).${/catalog: .* is missing/.test(output) ? " The catalog is missing: run /ai-dlc:workflow upgrade (repositories set up before it existed need this once)." : ""}\n${output}`);
