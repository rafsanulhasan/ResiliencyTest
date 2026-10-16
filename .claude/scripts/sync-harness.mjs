#!/usr/bin/env node
// sync-harness.mjs — keeps this repository's Claude Code and GitHub Copilot agent harness in step.
// Zero dependencies; Node 18+. Installed by the AI-DLC harness-sync skill; run it after adding or
// editing an agent, skill, command / prompt, rule / instruction or hook on either platform.
//
//   node .claude/scripts/sync-harness.mjs                  sync both ways (Claude <-> Copilot)
//   node .claude/scripts/sync-harness.mjs --check          report only; exit 1 if anything is out of sync
//   node .claude/scripts/sync-harness.mjs --prefer claude  the Claude side wins when both exist and differ
//   node .claude/scripts/sync-harness.mjs --only agents,rules --name reviewer
//
// Twins:
//   agents    .claude/agents/<n>.md            <-> .github/agents/<n>.agent.md
//   skills    .claude/skills/<n>/**            <-> .github/skills/<n>/**          (file by file)
//   commands  .claude/commands/<n>.md          <-> .github/prompts/<n>.prompt.md
//   rules     .claude/rules/**/<n>.md          <-> .github/instructions/**/<n>.instructions.md
//   hooks     .claude/settings.json "hooks"    <-> .github/hooks/*.json           (additive, by command)
//
// A missing twin is created from the side that exists. When both exist and differ, --prefer decides
// which side wins: claude, copilot, or newer (default: the file modified last). Only the fields both
// platforms share are synced (name, description, tools, status; description, argument-hint; description
// and scope; the body); platform-only frontmatter keys on the target are kept as they are. Nothing is
// ever deleted: removing an artifact, and hooks that cannot be translated, stay with agent-manager.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ---- options --------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
const CHECK = argv.includes("--check");
const PREFER = opt("--prefer") ?? "newer";
if (!["claude", "copilot", "newer"].includes(PREFER)) fail(`--prefer must be claude, copilot or newer (got "${PREFER}")`);
const KINDS = ["agents", "skills", "commands", "rules", "hooks"];
const ONLY = opt("--only")?.split(",").map((s) => s.trim()) ?? KINDS;
for (const k of ONLY) if (!KINDS.includes(k)) fail(`--only: unknown kind "${k}" (use ${KINDS.join(", ")})`);
const NAME = opt("--name");
const ROOT = path.resolve(opt("--root") ?? gitRoot() ?? process.cwd());

function gitRoot() {
  try { return execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}
function fail(msg) { console.error(`error: ${msg}`); process.exit(2); }

// ---- report ---------------------------------------------------------------------
const actions = []; // { verb, target, from, why }
const notes = [];
let inSync = 0;
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const note = (m) => notes.push(m);

// ---- files ----------------------------------------------------------------------
const exists = (p) => fs.existsSync(p);
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const mtime = (p) => fs.statSync(p).mtimeMs;
function walk(dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function write(target, content, from, why) {
  actions.push({ verb: exists(target) ? "update" : "create", target: rel(target), from: from && rel(from), why });
  if (CHECK) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
// Which side wins when both exist and differ.
function winner(claudePath, copilotPath) {
  if (PREFER !== "newer") return PREFER;
  return mtime(claudePath) >= mtime(copilotPath) ? "claude" : "copilot";
}

// ---- frontmatter ----------------------------------------------------------------
// A small YAML subset: top-level `key: value` entries with plain, quoted, flow-list, block-list and
// block-scalar values. Entries keep their raw lines, so keys this script does not sync are written
// back exactly as they were.
function splitDoc(text) {
  const m = text.match(/^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!m) return { entries: [], body: text };
  const entries = [];
  for (const line of m[1] ? m[1].split("\n") : []) {
    const k = line.match(/^([A-Za-z_][\w.-]*):(?=\s|$)/);
    if (k) entries.push({ key: k[1], raw: [line] });
    else if (entries.length) entries[entries.length - 1].raw.push(line);
    else entries.push({ key: null, raw: [line] });
  }
  return { entries, body: m[2] };
}

function unescapeDouble(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, c) => {
    if (c[0] === "u" || c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", "0": "\0", " ": " ", "/": "/", '"': '"', "\\": "\\" }[c] ?? c;
  });
}
const fold = (s) => s.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, "\u0000").replace(/[ \t]*\n[ \t]*/g, " ").replace(/\u0000/g, "\n");
function unquote(s) {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return unescapeDouble(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function splitFlow(s) {
  const out = [];
  let cur = "", q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}
function valueOf(entry) {
  const [first, ...rest] = entry.raw;
  const head = first.slice(first.indexOf(":") + 1).trim();
  const tail = rest.join("\n");
  if (head.startsWith('"') || head.startsWith("'")) {
    const all = [head, ...rest].join("\n").trim();
    const q = head[0];
    let i = 1;
    for (; i < all.length; i++) {
      if (q === '"' && all[i] === "\\") { i++; continue; }
      if (all[i] === q) { if (q === "'" && all[i + 1] === "'") { i++; continue; } break; }
    }
    const inner = fold(all.slice(1, i));
    return q === '"' ? unescapeDouble(inner) : inner.replace(/''/g, "'");
  }
  if (head.startsWith("[")) return splitFlow([head, ...rest].join(" ").trim().replace(/^\[|\]$/g, ""));
  if (/^[|>][+-]?\d*$/.test(head)) {
    const lines = rest.filter((l, i) => l.trim() || i < rest.length - 1);
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    const text = lines.map((l) => l.slice(indent)).join("\n").replace(/\n+$/, "");
    return head[0] === "|" ? text : fold(text);
  }
  if (head === "" && /^\s*-\s/.test(tail)) {
    return rest.map((l) => l.match(/^\s*-\s+(.*)$/)).filter(Boolean).map((m) => unquote(m[1].replace(/\s+#.*$/, "")));
  }
  if (head === "" && !tail.trim()) return "";
  return [head, ...rest.map((l) => l.trim())].filter(Boolean).join(" ").replace(/\s+#.*$/, "");
}
function fmObject(entries) {
  const o = {};
  for (const e of entries) if (e.key) o[e.key] = valueOf(e);
  return o;
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ .,/()*-]*$/;
const scalar = (s) => (PLAIN.test(s) && !/[\s,]$/.test(s) ? s : JSON.stringify(s));
function serialize(key, value, style) {
  if (Array.isArray(value)) {
    if (style === "flow") return [`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`];
    return [`${key}:`, ...value.map((v) => `  - ${JSON.stringify(v)}`)];
  }
  return [`${key}: ${style === "quoted" ? JSON.stringify(String(value)) : scalar(String(value))}`];
}
// Sets (value) or removes (undefined) keys, keeping every other entry and the order of existing keys.
function render(doc, updates, styles = {}) {
  const entries = doc.entries.map((e) => ({ ...e }));
  for (const [key, value] of Object.entries(updates)) {
    const i = entries.findIndex((e) => e.key === key);
    if (value === undefined) { if (i > -1) entries.splice(i, 1); continue; }
    const raw = serialize(key, value, styles[key]);
    if (i > -1) entries[i] = { key, raw };
    else entries.push({ key, raw });
  }
  const fm = entries.flatMap((e) => e.raw);
  const body = doc.body.replace(/^\n+/, "");
  return fm.length ? `---\n${fm.join("\n")}\n---\n\n${body}` : body;
}
const sameBody = (a, b) => a.replace(/^\s+/, "").replace(/\s+$/, "") === b.replace(/^\s+/, "").replace(/\s+$/, "");
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

// ---- generic twin sync for single-file artifacts ---------------------------------------
// spec: { kind, claudeDir, copilotDir, claudeExt, copilotExt, recursive, toCopilot, toClaude, differs }
// toX(sourceDoc, targetDocOrNull, name) -> { updates, styles, body }
function syncPairs(spec) {
  const list = (dir, ext) => {
    const files = spec.recursive ? walk(dir) : exists(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
    const map = new Map();
    for (const f of files) {
      if (!f.endsWith(ext) || !fs.statSync(f).isFile()) continue;
      const name = path.relative(dir, f).split(path.sep).join("/").slice(0, -ext.length);
      if (/^README$/i.test(path.basename(name))) continue;
      map.set(name, f);
    }
    return map;
  };
  const claude = list(spec.claudeDir, spec.claudeExt);
  const copilot = list(spec.copilotDir, spec.copilotExt);
  for (const name of [...new Set([...claude.keys(), ...copilot.keys()])].sort()) {
    if (NAME && path.basename(name) !== NAME) continue;
    const cPath = claude.get(name) ?? path.join(spec.claudeDir, name + spec.claudeExt);
    const gPath = copilot.get(name) ?? path.join(spec.copilotDir, name + spec.copilotExt);
    const cDoc = claude.has(name) ? splitDoc(readText(cPath)) : null;
    const gDoc = copilot.has(name) ? splitDoc(readText(gPath)) : null;
    // A soft-deleted twin (renamed to *.deprecated by agent-manager) is never recreated.
    const retired = !gDoc ? gPath : !cDoc ? cPath : null;
    if (retired && exists(retired + ".deprecated")) {
      note(`${spec.kind}/${name}: ${rel(retired)}.deprecated exists — not recreated; deprecate ${rel(retired === gPath ? cPath : gPath)} too`);
      continue;
    }
    try {
      if (!gDoc) { emit(spec.toCopilot(cDoc, null, name), null, gPath, cPath, "missing on Copilot"); continue; }
      if (!cDoc) { emit(spec.toClaude(gDoc, null, name), null, cPath, gPath, "missing on Claude"); continue; }
      if (!spec.differs(cDoc, gDoc, name)) { inSync++; continue; }
      if (winner(cPath, gPath) === "claude") emit(spec.toCopilot(cDoc, gDoc, name), gDoc, gPath, cPath, `drifted; Claude side wins (--prefer ${PREFER})`);
      else emit(spec.toClaude(gDoc, cDoc, name), cDoc, cPath, gPath, `drifted; Copilot side wins (--prefer ${PREFER})`);
    } catch (e) {
      note(`${spec.kind}/${name}: ${e.message} — left unchanged; ask agent-manager to reconcile it`);
    }
  }
}
function emit(result, targetDoc, target, from, why) {
  const doc = targetDoc ?? { entries: [], body: "" };
  write(target, render({ entries: doc.entries, body: result.body }, result.updates, result.styles), from, why);
}

// ---- agents -----------------------------------------------------------------------
// Claude tool -> Copilot alias; same table as the plugin's build-copilot.mjs.
const ALIAS = {
  Read: "read", NotebookRead: "read",
  Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Glob: "search", Grep: "search",
  Bash: "execute", PowerShell: "execute",
  TodoWrite: "todo",
  Agent: "agent", Task: "agent",
  WebFetch: "web", WebSearch: "web",
};
// Claude-only tools with no Copilot equivalent, dropped silently; same list as build-copilot.mjs.
const CLAUDE_ONLY = /^(PushNotification|ToolSearch|Task(Create|Get|List|Update|Stop|Output)|Cron(Create|Delete|List)|Monitor|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|RemoteTrigger|ScheduleWakeup|Skill|SendMessage|AskUserQuestion|mcp__ide__.*)$/;
const REVERSE = { read: ["Read"], edit: ["Edit", "Write"], search: ["Glob", "Grep"], execute: ["Bash"], todo: ["TodoWrite"], agent: ["Agent"], web: ["WebFetch", "WebSearch"] };
const ALL_ALIASES = Object.keys(REVERSE);
const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const portable = (t) => ALL_ALIASES.includes(t) || t.startsWith("mcp__");

// The Copilot tool set a Claude agent maps to; null means "inherits every tool".
function copilotTools(c) {
  if (c.tools !== undefined && c.tools !== "") return [...new Set(asList(c.tools).map((t) => ALIAS[t] ?? (t.startsWith("mcp__") && !CLAUDE_ONLY.test(t) ? t : null)).filter(Boolean))];
  if (c.disallowedTools !== undefined) {
    const denied = new Set(asList(c.disallowedTools).map((t) => ALIAS[t]).filter(Boolean));
    return ALL_ALIASES.filter((a) => !denied.has(a));
  }
  return null;
}
const agentDiffers = (cDoc, gDoc, name) => {
  const c = fmObject(cDoc.entries), g = fmObject(gDoc.entries);
  const gTools = g.tools === undefined ? null : asList(g.tools).filter(portable);
  const cTools = copilotTools(c);
  return !sameValue(c.name ?? name, g.name ?? name) || !sameValue(c.description, g.description)
    || !sameValue(c.status, g.status) || !sameBody(cDoc.body, gDoc.body)
    || !(cTools === null ? gTools === null : gTools !== null && sameSet(cTools, gTools));
};
function agentToCopilot(cDoc, gDoc, name) {
  const c = fmObject(cDoc.entries);
  const g = gDoc ? fmObject(gDoc.entries) : {};
  const tools = copilotTools(c);
  // Copilot-only tools (no Claude equivalent) already on the target are kept.
  const local = g.tools === undefined ? [] : asList(g.tools).filter((t) => !portable(t));
  for (const t of asList(c.tools)) if (!ALIAS[t] && !t.startsWith("mcp__") && !CLAUDE_ONLY.test(t)) note(`agents/${name}: Claude tool "${t}" has no Copilot equivalent — not copied`);
  return {
    updates: { name: c.name ?? name, description: c.description, tools: tools === null ? undefined : [...tools, ...local], status: c.status },
    styles: { tools: "flow" },
    body: cDoc.body,
  };
}
function agentToClaude(gDoc, cDoc, name) {
  const g = fmObject(gDoc.entries);
  const c = cDoc ? fmObject(cDoc.entries) : {};
  const updates = { name: g.name ?? name, description: g.description, status: g.status };
  if (g.tools === undefined) updates.tools = undefined;
  else if (c.disallowedTools !== undefined && c.tools === undefined) {
    note(`agents/${name}: Claude side uses disallowedTools — tools not synced; reconcile by hand`);
  } else {
    const wanted = asList(g.tools).filter(portable);
    for (const t of asList(g.tools)) if (!portable(t)) note(`agents/${name}: Copilot tool "${t}" has no Claude equivalent — not copied`);
    // Keep the existing Claude list when it already maps to the same Copilot set; else rebuild it,
    // keeping Claude-only tools (Skill, AskUserQuestion, …) that have no Copilot alias.
    const current = asList(c.tools);
    const currentMaps = copilotTools({ tools: current.join(",") }) ?? [];
    if (!(current.length && sameSet(currentMaps, wanted))) {
      const claudeOnly = current.filter((t) => !ALIAS[t] && !t.startsWith("mcp__"));
      const kept = current.filter((t) => wanted.includes(ALIAS[t]) || (t.startsWith("mcp__") && wanted.includes(t)));
      const added = wanted.flatMap((a) => (a.startsWith("mcp__") ? [a] : kept.some((t) => ALIAS[t] === a) ? [] : REVERSE[a]));
      updates.tools = [...new Set([...kept, ...added, ...claudeOnly])].join(", ");
    }
  }
  if (!cDoc) updates.model = "inherit";
  return { updates, body: gDoc.body };
}

// ---- commands / prompts -------------------------------------------------------------
const toPromptBody = (b) => b.replace(/\$ARGUMENTS\b/g, "${input:arguments}");
const toCommandBody = (b) => b.replace(/\$\{input:arguments(?::[^}]*)?\}/g, "$ARGUMENTS");
const commandDiffers = (cDoc, gDoc) => {
  const c = fmObject(cDoc.entries), g = fmObject(gDoc.entries);
  return !sameValue(c.description, g.description) || !sameValue(c["argument-hint"], g["argument-hint"])
    || !sameBody(cDoc.body, toCommandBody(gDoc.body));
};
function commandToPrompt(cDoc, gDoc, name) {
  const c = fmObject(cDoc.entries);
  if (/\$[1-9]/.test(cDoc.body)) note(`commands/${name}: positional $1… arguments have no Copilot equivalent — copied as written`);
  const updates = { description: c.description, "argument-hint": c["argument-hint"] };
  if (!gDoc) updates.agent = "agent";
  return { updates, body: toPromptBody(cDoc.body) };
}
function promptToCommand(gDoc, cDoc) {
  const g = fmObject(gDoc.entries);
  return { updates: { description: g.description, "argument-hint": g["argument-hint"] }, body: toCommandBody(gDoc.body) };
}

// ---- rules / instructions -----------------------------------------------------------
// Claude `paths` (or the older `globs`) is a list; Copilot `applyTo` is one comma-separated string.
// A Claude rule without paths always loads, which is `applyTo: "**"` on Copilot.
const EVERYWHERE = ["**", "**/*"];
const ruleScope = (c) => { const p = asList(c.paths ?? c.globs); return p.length ? p : ["**"]; };
const instructionScope = (g) => { const p = asList(g.applyTo); return p.length ? p : ["**"]; };
const normScope = (s) => (s.every((x) => EVERYWHERE.includes(x)) ? ["**"] : s);
const ruleDiffers = (cDoc, gDoc) => {
  const c = fmObject(cDoc.entries), g = fmObject(gDoc.entries);
  return !sameValue(c.description, g.description) || !sameSet(normScope(ruleScope(c)), normScope(instructionScope(g)))
    || !sameBody(cDoc.body, gDoc.body);
};
function ruleToInstruction(cDoc) {
  const c = fmObject(cDoc.entries);
  return { updates: { description: c.description, applyTo: normScope(ruleScope(c)).join(",") }, styles: { applyTo: "quoted" }, body: cDoc.body };
}
function instructionToRule(gDoc, cDoc) {
  const g = fmObject(gDoc.entries);
  const c = cDoc ? fmObject(cDoc.entries) : {};
  const scope = normScope(instructionScope(g));
  const key = c.globs !== undefined && c.paths === undefined ? "globs" : "paths";
  const updates = { description: g.description, [key]: scope[0] === "**" ? undefined : scope };
  return { updates, body: gDoc.body };
}

// ---- skills (file by file) ------------------------------------------------------------
function syncSkills() {
  const cRoot = path.join(ROOT, ".claude", "skills"), gRoot = path.join(ROOT, ".github", "skills");
  const dirs = (r) => (exists(r) ? fs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name) : []);
  for (const skill of [...new Set([...dirs(cRoot), ...dirs(gRoot)])].sort()) {
    if (NAME && skill !== NAME) continue;
    const cDir = path.join(cRoot, skill), gDir = path.join(gRoot, skill);
    const files = new Set([...walk(cDir).map((p) => path.relative(cDir, p)), ...walk(gDir).map((p) => path.relative(gDir, p))]);
    let changed = false;
    for (const f of [...files].sort()) {
      const c = path.join(cDir, f), g = path.join(gDir, f);
      if (!exists(g)) { copy(c, g, "missing on Copilot"); changed = true; continue; }
      if (!exists(c)) { copy(g, c, "missing on Claude"); changed = true; continue; }
      if (fs.readFileSync(c).toString("latin1").replace(/\r\n/g, "\n") === fs.readFileSync(g).toString("latin1").replace(/\r\n/g, "\n")) continue;
      if (winner(c, g) === "claude") copy(c, g, `drifted; Claude side wins (--prefer ${PREFER})`);
      else copy(g, c, `drifted; Copilot side wins (--prefer ${PREFER})`);
      changed = true;
    }
    if (!changed) inSync++;
    const skillMd = path.join(cDir, "SKILL.md");
    if (exists(skillMd) && readText(skillMd).includes("${CLAUDE_SKILL_DIR}")) {
      note(`skills/${skill}: uses \${CLAUDE_SKILL_DIR}, which Copilot does not expand — use paths relative to SKILL.md`);
    }
  }
}
function copy(from, to, why) {
  actions.push({ verb: exists(to) ? "update" : "create", target: rel(to), from: rel(from), why });
  if (CHECK) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ---- hooks (additive, matched by command) -------------------------------------------------
// Claude events and their Copilot names; same table as the plugin's build-copilot.mjs.
const EVENT = {
  Stop: "agentStop", SubagentStop: "subagentStop", PreToolUse: "preToolUse",
  PostToolUse: "postToolUse", SessionStart: "sessionStart", SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmitted", PreCompact: "preCompact", Notification: "notification",
};
const CLAUDE_EVENT = Object.fromEntries(Object.entries(EVENT).map(([k, v]) => [v, k]));
const SYNCED_HOOKS = ".github/hooks/synced-from-claude.json";
function syncHooks() {
  const settingsPath = path.join(ROOT, ".claude", "settings.json");
  const hooksDir = path.join(ROOT, ".github", "hooks");
  let settings = {};
  try { settings = exists(settingsPath) ? JSON.parse(readText(settingsPath)) : {}; } catch (e) { note(`hooks: .claude/settings.json is not valid JSON (${e.message}) — hooks skipped`); return; }

  // Every Copilot hook command, per Copilot event.
  const copilot = new Map(); // event -> Set(command)
  const copilotFiles = [];
  for (const f of walk(hooksDir).filter((p) => p.endsWith(".json"))) {
    let doc;
    try { doc = JSON.parse(readText(f)); } catch (e) { note(`hooks: ${rel(f)} is not valid JSON — skipped`); continue; }
    copilotFiles.push({ file: f, doc });
    for (const [event, list] of Object.entries(doc.hooks ?? {})) {
      for (const h of list ?? []) for (const cmd of [h.bash, h.powershell, h.command]) if (cmd) (copilot.get(event) ?? copilot.set(event, new Set()).get(event)).add(cmd);
    }
  }
  // Every Claude hook command, per Claude event.
  const claude = new Map();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const grp of groups ?? []) for (const h of grp.hooks ?? []) if (h.command) (claude.get(event) ?? claude.set(event, new Set()).get(event)).add(h.command);
  }

  // Claude -> Copilot
  const syncedPath = path.join(ROOT, SYNCED_HOOKS);
  const synced = copilotFiles.find((x) => x.file === syncedPath)?.doc ?? { version: 1, hooks: {} };
  let addCopilot = 0;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const grp of groups ?? []) {
      for (const h of grp.hooks ?? []) {
        const label = `hooks: Claude ${event}${grp.matcher ? ` (${grp.matcher})` : ""} "${h.command ?? h.type}"`;
        if (h.type && h.type !== "command") { note(`${label} is a ${h.type} hook — Copilot runs commands only; not synced`); continue; }
        const target = EVENT[event];
        if (!target) { note(`${label}: no Copilot ${event} event — not synced`); continue; }
        if (copilot.get(target)?.has(h.command)) continue;
        if (/CLAUDE_(PROJECT_DIR|PLUGIN_ROOT)/.test(h.command)) note(`${label} uses a CLAUDE_* variable that Copilot does not set — check the copy`);
        const entry = { type: "command", bash: h.command, powershell: h.command, timeoutSec: h.timeout ?? 30 };
        if (grp.matcher) entry.matcher = grp.matcher;
        (synced.hooks[target] ??= []).push(entry);
        (copilot.get(target) ?? copilot.set(target, new Set()).get(target)).add(h.command);
        actions.push({ verb: "add hook", target: SYNCED_HOOKS, from: ".claude/settings.json", why: `${event} → ${target}: ${h.command}` });
        addCopilot++;
      }
    }
  }
  if (addCopilot && !CHECK) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(syncedPath, JSON.stringify(synced, null, 2) + "\n");
  }

  // Copilot -> Claude
  let addClaude = 0;
  for (const { file, doc } of copilotFiles) {
    if (file === syncedPath) continue;
    for (const [event, list] of Object.entries(doc.hooks ?? {})) {
      for (const h of list ?? []) {
        const cmd = h.bash ?? h.command ?? h.powershell;
        const label = `hooks: ${rel(file)} ${event} "${cmd}"`;
        const target = CLAUDE_EVENT[event];
        if (!target) { note(`${label}: no Claude ${event} event — not synced`); continue; }
        const known = claude.get(target);
        if (!cmd || [h.bash, h.powershell, h.command].some((c) => c && known?.has(c))) continue;
        if (!h.bash && h.powershell) note(`${label} is PowerShell-only — Claude runs it through its default shell; check the copy`);
        const group = { hooks: [{ type: "command", command: cmd, timeout: h.timeoutSec ?? 30 }] };
        if (h.matcher) group.matcher = h.matcher;
        ((settings.hooks ??= {})[target] ??= []).push(group);
        (claude.get(target) ?? claude.set(target, new Set()).get(target)).add(cmd);
        actions.push({ verb: "add hook", target: ".claude/settings.json", from: rel(file), why: `${event} → ${target}: ${cmd}` });
        addClaude++;
      }
    }
  }
  if (addClaude && !CHECK) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  if (!addCopilot && !addClaude) inSync++;
}

// ---- run ------------------------------------------------------------------------------
const C = (...p) => path.join(ROOT, ".claude", ...p);
const G = (...p) => path.join(ROOT, ".github", ...p);
if (ONLY.includes("agents")) syncPairs({ kind: "agents", claudeDir: C("agents"), copilotDir: G("agents"), claudeExt: ".md", copilotExt: ".agent.md", differs: agentDiffers, toCopilot: agentToCopilot, toClaude: agentToClaude });
if (ONLY.includes("skills")) syncSkills();
if (ONLY.includes("commands")) syncPairs({ kind: "commands", claudeDir: C("commands"), copilotDir: G("prompts"), claudeExt: ".md", copilotExt: ".prompt.md", differs: commandDiffers, toCopilot: commandToPrompt, toClaude: promptToCommand });
if (ONLY.includes("rules")) syncPairs({ kind: "rules", claudeDir: C("rules"), copilotDir: G("instructions"), claudeExt: ".md", copilotExt: ".instructions.md", recursive: true, differs: ruleDiffers, toCopilot: ruleToInstruction, toClaude: instructionToRule });
if (ONLY.includes("hooks") && !NAME) syncHooks();

for (const a of actions) console.log(`${CHECK ? "would " : ""}${a.verb.padEnd(9)} ${a.target}${a.from ? `  ← ${a.from}` : ""}  (${a.why})`);
for (const n of notes) console.warn(`note: ${n}`);
console.log(`${actions.length ? `${actions.length} change(s) ${CHECK ? "pending" : "written"}` : "Everything in sync"}; ${inSync} artifact(s) already in sync.`);
if (CHECK && actions.length) { console.log("Run without --check to apply."); process.exit(1); }
