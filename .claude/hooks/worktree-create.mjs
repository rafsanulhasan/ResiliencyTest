#!/usr/bin/env node
// worktree-create.mjs — AI-DLC Claude Code "WorktreeCreate" hook.
// Installed into a repository by /ai-dlc:init. Creates every Claude worktree (claude --worktree,
// EnterWorktree, isolation: "worktree" subagents, background sessions) under the worktree root
// chosen at init instead of Claude's default .claude/worktrees/.
// Dependency-free; runs on Windows, macOS and Linux with Node.js 18 or later.
//
//   node worktree-create.mjs --root <path> [--base fresh|head]
//
//   --root  worktree root; relative paths resolve against the main repository root
//   --base  fresh (default): branch from the remote default branch (origin/HEAD), else local HEAD
//           head: branch from the HEAD of the directory the session runs in
//
// Contract (https://code.claude.com/docs/en/hooks#worktreecreate): stdin is JSON with `name`
// (a slug) and `cwd`; the last non-empty stdout line must be the absolute path of the created
// directory; any non-zero exit fails the creation. All other output goes to stderr.
// Mirrors Claude's defaults: directory <root>/<name>, new branch worktree-<name>. Because the
// hook replaces Claude's built-in logic, Claude no longer processes .worktreeinclude, so this
// script copies those files itself.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fail = (message) => {
  process.stderr.write(`ai-dlc worktree-create: ${message}\n`);
  process.exit(1);
};
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const rootArg = arg("--root");
const base = (arg("--base") ?? "fresh").toLowerCase();
if (!rootArg) fail("missing --root <path>");
if (!["fresh", "head"].includes(base)) fail(`--base must be "fresh" or "head", got "${base}"`);

let payload = {};
try {
  const raw = fs.readFileSync(0, "utf8");
  if (raw.trim()) payload = JSON.parse(raw);
} catch (e) {
  fail(`could not parse the hook input as JSON: ${e.message}`);
}
const name = String(payload.name ?? "").trim();
if (!name) fail("the hook input has no `name`");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
  fail(`refusing worktree name "${name}": use letters, digits, ".", "_" and "-" only`);
}

const sessionDir = [payload.cwd, process.env.CLAUDE_PROJECT_DIR].find((d) => d && fs.existsSync(d)) ?? process.cwd();
const git = (args, cwd, options = {}) =>
  spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, ...options });
const gitOk = (args, cwd, what) => {
  const r = git(args, cwd);
  if (r.error) fail(`${what}: ${r.error.message}`);
  if (r.status !== 0) fail(`${what}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim();
};

// The main checkout is the parent of the common .git directory, also when the session already
// runs inside a worktree.
const commonDir = path.resolve(sessionDir, gitOk(["rev-parse", "--git-common-dir"], sessionDir, "not a git repository"));
if (path.basename(commonDir) !== ".git") fail(`unsupported repository layout (common git dir ${commonDir})`);
const repoRoot = path.dirname(commonDir);

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const worktreeRoot = path.resolve(repoRoot, rootArg);
const target = path.join(worktreeRoot, name);
const branch = `worktree-${name}`;

// Re-entering an existing worktree: hand its path back unchanged.
const registered = gitOk(["worktree", "list", "--porcelain"], repoRoot, "git worktree list")
  .split(/\r?\n/)
  .filter((l) => l.startsWith("worktree "))
  .map((l) => path.resolve(l.slice("worktree ".length)));
if (registered.some((p) => samePath(p, target))) {
  process.stdout.write(`${target}\n`);
  process.exit(0);
}
if (fs.existsSync(target)) fail(`${target} exists but is not a git worktree of this repository`);

// Base ref, following Claude's documented defaults.
function baseRef() {
  if (base === "head") return gitOk(["rev-parse", "HEAD"], sessionDir, "cannot resolve HEAD");
  const remoteHead = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) {
    const ref = remoteHead.stdout.trim(); // e.g. origin/main
    // Best effort, capped like Claude's own refresh; the cached ref is used if it fails.
    git(["fetch", "--quiet", "origin", ref.replace(/^origin\//, "")], repoRoot, { timeout: 5000 });
    return ref;
  }
  return gitOk(["rev-parse", "HEAD"], repoRoot, "cannot resolve HEAD");
}

fs.mkdirSync(worktreeRoot, { recursive: true });
const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).status === 0;
const addArgs = branchExists
  ? ["worktree", "add", target, branch]
  : ["worktree", "add", "--no-track", "-b", branch, target, baseRef()];
const add = git(addArgs, repoRoot);
if (add.error) fail(`git worktree add: ${add.error.message}`);
process.stderr.write(`${add.stdout ?? ""}${add.stderr ?? ""}`);
if (add.status !== 0) fail(`git worktree add failed (exit ${add.status})`);

// .worktreeinclude: copy the gitignored files it matches (same rule as Claude's built-in logic).
const includeFile = path.join(repoRoot, ".worktreeinclude");
if (fs.existsSync(includeFile)) {
  const listed = (args) => {
    const r = git(["ls-files", "-z", "--others", "--ignored", ...args], repoRoot);
    return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
  };
  const ignored = new Set(listed(["--exclude-standard"]));
  let copied = 0;
  for (const rel of listed([`--exclude-from=${includeFile}`])) {
    if (!ignored.has(rel)) continue;
    const to = path.join(target, rel);
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, rel), to);
      copied++;
    } catch (e) {
      process.stderr.write(`ai-dlc worktree-create: could not copy ${rel}: ${e.message}\n`);
    }
  }
  process.stderr.write(`ai-dlc worktree-create: copied ${copied} file(s) from .worktreeinclude\n`);
}

// Last stdout line = the path Claude Code enters.
process.stdout.write(`${target}\n`);
