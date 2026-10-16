#!/usr/bin/env node
// worktree-remove.mjs — AI-DLC Claude Code "WorktreeRemove" hook, the twin of worktree-create.mjs.
// Installed into a repository by /ai-dlc:init. Dependency-free; Windows, macOS and Linux, Node.js 18+.
//
//   node worktree-remove.mjs
//
// Contract (https://code.claude.com/docs/en/hooks#worktreeremove): stdin is JSON with
// `worktree_path` (absolute). Exit 0 means the worktree counts as removed; a non-zero exit fails
// the removal if the directory still exists. Claude Code never deletes the branch of a
// hook-created worktree, so this script deletes `worktree-<name>` when it is fully merged and
// keeps it (with a note on stderr) when it holds unmerged commits.
// Claude does not call this hook when a subagent or workflow agent finishes; remove those
// worktrees with `git worktree remove <path>` once their work is merged.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const note = (message) => process.stderr.write(`ai-dlc worktree-remove: ${message}\n`);
const fail = (message) => {
  note(message);
  process.exit(1);
};

let payload = {};
try {
  const raw = fs.readFileSync(0, "utf8");
  if (raw.trim()) payload = JSON.parse(raw);
} catch (e) {
  fail(`could not parse the hook input as JSON: ${e.message}`);
}
const worktreePath = payload.worktree_path ? path.resolve(payload.worktree_path) : "";
if (!worktreePath) fail("the hook input has no `worktree_path`");
if (!fs.existsSync(worktreePath)) process.exit(0); // already gone

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

const common = git(["rev-parse", "--git-common-dir"], worktreePath);
if (common.status !== 0) fail(`${worktreePath} is not inside a git worktree: ${common.stderr.trim()}`);
const repoRoot = path.dirname(path.resolve(worktreePath, common.stdout.trim()));
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (samePath(repoRoot, worktreePath)) fail("refusing to remove the main checkout");

const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath);
const branch = head.status === 0 ? head.stdout.trim() : "";

// --force matches what Claude Code does when no hook is configured.
const removed = git(["worktree", "remove", "--force", worktreePath], repoRoot);
if (removed.status !== 0) fail(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`);
git(["worktree", "prune"], repoRoot);

if (branch.startsWith("worktree-")) {
  const del = git(["branch", "-d", branch], repoRoot);
  if (del.status !== 0) note(`kept branch ${branch}: it has unmerged commits (delete it with git branch -D ${branch})`);
}
