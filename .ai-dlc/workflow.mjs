#!/usr/bin/env node
// workflow.mjs — checks, shows and compares this repository's AI-DLC workflow (.ai-dlc/workflow.json).
// Zero dependencies; Node 18+. Installed by the AI-DLC workflow skill; change the workflow itself with
// /ai-dlc:workflow edit <change> (agent-manager), then run validate.
//
//   node .ai-dlc/workflow.mjs validate [--file <path>]           structural and semantic checks
//   node .ai-dlc/workflow.mjs show [<lifecycle>] [--mermaid]     stage tables and gates, or flowcharts
//   node .ai-dlc/workflow.mjs diff --against <path> [--file <p>]  what differs from another workflow file
//   node .ai-dlc/workflow.mjs catalog --plugin <dir> [--out <p>]  record the plugin's agents and skills
//
// Options:
//   --file <path>     the workflow file to read (default: <root>/.ai-dlc/workflow.json)
//   --root <dir>      repository root, where project agents and skills are found (default: git root, else cwd)
//   --catalog <path>  the plugin catalog (default: <root>/.ai-dlc/catalog.json, written by `catalog`)
//   --plugin <dir>    the plugin root (agents/, skills/); validate and show build the catalog from it in memory
//   --out <path>      where `catalog` writes (default: <root>/.ai-dlc/catalog.json)
//
// Exit codes: 0 ok (no errors; diff: no differences) · 1 problems (errors or no catalog; diff: differences)
//             2 usage error or unreadable file.
// Warnings never fail validate. Agent ids and skill names are bare (software-engineer, write-tests);
// the orchestrator adds the ai-dlc: prefix for plugin ones.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ---- options --------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(argv.length === 0 ? 2 : 0);
}
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
const VALUE_OPTS = ["--file", "--root", "--against", "--catalog", "--plugin", "--out"];
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_OPTS.includes(argv[i - 1]));
const COMMAND = positional[0];
if (!["validate", "show", "diff", "catalog"].includes(COMMAND)) usage(`unknown command "${COMMAND ?? ""}" (use validate, show, diff or catalog)`);
for (const a of argv) if (a.startsWith("--") && ![...VALUE_OPTS, "--mermaid"].includes(a)) usage(`unknown option ${a}`);
for (const o of VALUE_OPTS) if (argv.includes(o) && (!opt(o) || opt(o).startsWith("--"))) usage(`${o} needs a value`);
const ROOT = path.resolve(opt("--root") ?? gitRoot() ?? process.cwd());
const FILE = path.resolve(opt("--file") ?? path.join(ROOT, ".ai-dlc", "workflow.json"));
const CATALOG_FILE = path.resolve(opt("--catalog") ?? path.join(ROOT, ".ai-dlc", "catalog.json"));

function gitRoot() {
  try { return execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}
function usage(msg) { console.error(`error: ${msg}\nRun with --help for usage.`); process.exit(2); }

// ---- catalog --------------------------------------------------------------------
// The plugin's agents and skills are never hard-coded here. `catalog` reads them from the installed
// plugin into .ai-dlc/catalog.json (run by /ai-dlc:workflow install and upgrade, and by /ai-dlc:init);
// validate reads that file, or builds the same catalog in memory from --plugin.
const listDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const isDeprecated = (file) => {
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, "utf8"));
    return Boolean(fm && /^status:\s*deprecated\s*$/m.test(fm[1]));
  } catch { return false; }
};

function buildCatalog(pluginDir) {
  const root = path.resolve(pluginDir);
  const manifest = [path.join(root, ".claude-plugin", "plugin.json"), path.join(root, "plugin.json")].find((f) => fs.existsSync(f));
  if (!manifest) usage(`--plugin ${pluginDir}: no .claude-plugin/plugin.json or plugin.json, so it is not a plugin root`);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch (e) { usage(`${manifest} is not valid JSON: ${e.message}`); }
  // Claude agents are agents/<id>.md, Copilot agents agents/<id>.agent.md. Deprecated ones are left out.
  const agents = listDir(path.join(root, "agents"))
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !isDeprecated(path.join(root, "agents", e.name)))
    .map((e) => e.name.replace(/(\.agent)?\.md$/, ""));
  const skills = listDir(path.join(root, "skills"))
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, "skills", e.name, "SKILL.md")) && !isDeprecated(path.join(root, "skills", e.name, "SKILL.md")))
    .map((e) => e.name);
  if (!agents.length) usage(`--plugin ${pluginDir}: no agents in ${path.join(root, "agents")}`);
  return { plugin: { name: meta.name ?? null, version: meta.version ?? null }, agents: [...new Set(agents)].sort(), skills: [...new Set(skills)].sort() };
}

function loadCatalog() {
  if (opt("--plugin")) return buildCatalog(opt("--plugin"));
  let text;
  try { text = fs.readFileSync(CATALOG_FILE, "utf8"); } catch { return null; }
  let c;
  try { c = JSON.parse(text); } catch (e) { console.error(`error: ${CATALOG_FILE} is not valid JSON: ${e.message}`); process.exit(2); }
  if (!isObj(c) || !isStrArr(c.agents) || !isStrArr(c.skills)) {
    console.error(`error: ${CATALOG_FILE} needs "agents" and "skills" arrays; regenerate it with /ai-dlc:workflow upgrade`);
    process.exit(2);
  }
  return c;
}

// The project's own agents and skills, on either platform.
function projectRoster() {
  const agents = new Set(), skills = new Set();
  for (const [dir, re] of [[".claude/agents", /\.md$/], [".github/agents", /\.agent\.md$/]])
    for (const e of listDir(path.join(ROOT, dir))) if (e.isFile() && re.test(e.name)) agents.add(e.name.replace(/(\.agent)?\.md$/, ""));
  for (const dir of [".claude/skills", ".github/skills"])
    for (const e of listDir(path.join(ROOT, dir))) if (e.isDirectory() && fs.existsSync(path.join(ROOT, dir, e.name, "SKILL.md"))) skills.add(e.name);
  return { agents, skills };
}

// "Did you mean": the closest known name within a small edit distance, or "".
function didYouMean(word, names) {
  const dist = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  let best = null, bestD = Infinity;
  for (const n of names) { const d = dist(word, n); if (d < bestD) { best = n; bestD = d; } }
  return best && bestD <= Math.max(2, Math.floor(word.length / 3)) ? ` (did you mean "${best}"?)` : "";
}

// Fixed guardrail: these run every agent-artifact change (AAW), so a project cannot disable them.
const UNDISABLEABLE = {
  "orchestrator": "",
  "agent-manager": "",
  "brutal-critique": ": it critiques the docs of every agent-artifact change",
  "sqa-engineer": ": it tests the code of every agent-artifact change",
  "code-reviewer": ": it reviews the code of every agent-artifact change",
};
// AAW review stages: the only `when` each may carry, and why it must loop back to agent-manager.
const AAW_REVIEWERS = {
  "brutal-critique": { when: "the change set contains docs", why: "on REVISE: the docs of every agent-artifact change are critiqued" },
  "sqa-engineer": { when: "the change set contains code", why: "on failing tests: the code of every agent-artifact change is tested" },
  "code-reviewer": { when: "the change set contains code", why: "on Blockers or Warnings: the code of every agent-artifact change is reviewed" },
};
const APPROVERS = ["human", "orchestrator", "none"];
const KINDS = ["primary", "segment", "focused", "custom"];
const AXES = ["standards", "spec"];
const ARTIFACTS = ["backlog", "product", "specs", "decisions", "narratives", "plans", "handoffs"];
const TOP = ["$schema", "version", "agents", "gates", "lifecycles", "routing", "clarify", "documents", "review", "artifacts"];
const STAGE_KEYS = ["id", "agent", "skills", "produces", "after", "when", "gate", "loop", "critique", "note"];
const ID = /^[a-z][a-z0-9-]*$/;
const CODE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function load(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch {
    console.error(`error: cannot read ${file}${opt("--file") ? "" : " (no project workflow: the plugin default applies; install one with /ai-dlc:workflow install)"}`);
    process.exit(2);
  }
  try { return JSON.parse(text); } catch (e) { console.error(`error: ${file} is not valid JSON: ${e.message}`); process.exit(2); }
}

// ---- validate -------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const dupes = (arr) => [...new Set(arr.filter((x, i) => arr.indexOf(x) !== i))];

function validate(wf, catalog) {
  const errors = [], warnings = [];
  // Without a catalog the plugin's agents and skills are unknown: name checks are skipped here, and
  // the validate command reports the missing catalog as an error (show does not).
  const PLUGIN_AGENTS = catalog ? catalog.agents : [];
  const PLUGIN_SKILLS = catalog ? catalog.skills : [];
  const project = projectRoster();
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const wrn = (p, m) => warnings.push(`${p}: ${m}`);
  const unknownKeys = (obj, allowed, p) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${p}.${k}`, "unknown key"); };

  if (!isObj(wf)) { err("$", "the workflow must be a JSON object"); return { errors, warnings }; }
  unknownKeys(wf, TOP, "$");
  for (const k of TOP.slice(1)) if (!(k in wf)) err("$", `missing required key "${k}"`);
  if ("version" in wf && wf.version !== 1) err("version", "must be 1");

  // agents
  const disabled = new Set(), custom = new Set();
  if (isObj(wf.agents)) {
    unknownKeys(wf.agents, ["disabled", "custom"], "agents");
    if (!isStrArr(wf.agents.disabled)) err("agents.disabled", "must be an array of agent ids");
    else for (const d of dupes(wf.agents.disabled)) err("agents.disabled", `"${d}" is listed twice`);
    if (isStrArr(wf.agents.disabled)) for (const a of wf.agents.disabled) {
      if (catalog && !PLUGIN_AGENTS.includes(a)) err("agents.disabled", `"${a}" is not a plugin agent${didYouMean(a, PLUGIN_AGENTS)}`);
      else if (Object.hasOwn(UNDISABLEABLE, a)) err("agents.disabled", `"${a}" cannot be disabled (fixed guardrail${UNDISABLEABLE[a]})`);
      else disabled.add(a);
    }
    if (!isObj(wf.agents.custom)) err("agents.custom", "must be an object of { <id>: { description } }");
    else for (const [id, def] of Object.entries(wf.agents.custom)) {
      const p = `agents.custom.${id}`;
      if (!ID.test(id)) err(p, "id must be kebab-case");
      if (PLUGIN_AGENTS.includes(id)) err(p, "id collides with a plugin agent");
      if (id === "human") err(p, `"human" is reserved`);
      if (!isObj(def) || !isStr(def.description)) err(p, "needs a description");
      else unknownKeys(def, ["description"], p);
      if (!project.agents.has(id)) err(p, `no agent file: expected .claude/agents/${id}.md or .github/agents/${id}.agent.md`);
      custom.add(id);
    }
  } else if ("agents" in wf) err("agents", "must be an object");

  const usedAgent = (a, p, { human = false } = {}) => {
    if (human && a === "human") return;
    if (typeof a !== "string") return err(p, "must be an agent id");
    if (a.includes(":")) return err(p, `"${a}": use the bare id, without a namespace prefix`);
    if (disabled.has(a)) return err(p, `"${a}" is disabled in agents.disabled — reassign or remove`);
    if (!catalog || PLUGIN_AGENTS.includes(a) || custom.has(a)) return;
    if (project.agents.has(a)) return err(p, `"${a}" is a project agent but not declared in agents.custom`);
    err(p, `unknown agent "${a}" (not a plugin agent, not in agents.custom)${didYouMean(a, [...PLUGIN_AGENTS, ...custom])}; if a newer plugin added it, run /ai-dlc:workflow upgrade`);
  };
  // A stage skill must be a plugin skill (catalog) or a project skill (.claude/skills, .github/skills).
  const usedSkill = (k, p) => {
    if (k.includes(":")) return err(p, `"${k}": use the bare skill name, without a namespace prefix`);
    if (!catalog || PLUGIN_SKILLS.includes(k) || project.skills.has(k)) return;
    err(p, `unknown skill "${k}" (not a plugin skill, not in .claude/skills or .github/skills)${didYouMean(k, [...PLUGIN_SKILLS, ...project.skills])}; if a newer plugin added it, run /ai-dlc:workflow upgrade`);
  };

  // gates
  const gates = isObj(wf.gates) ? wf.gates : {};
  if ("gates" in wf && !isObj(wf.gates)) err("gates", "must be an object");
  for (const [g, def] of Object.entries(gates)) {
    const p = `gates.${g}`;
    if (!CODE.test(g)) err(p, "gate id must start with a letter and use letters, digits, - or _");
    if (!isObj(def)) { err(p, "must be an object"); continue; }
    unknownKeys(def, ["name", "approves", "approver", "note"], p);
    if (!isStr(def.name)) err(p, "needs a name");
    if (!isStr(def.approves)) err(p, "needs `approves` (the artifact signed off)");
    if (!APPROVERS.includes(def.approver)) err(p, `approver must be ${APPROVERS.join(", ")}`);
    else if (def.approver === "none") wrn(p, `approver is none — ${g === "G4" ? "the review report reaches merge without sign-off" : "nobody signs off this gate"}`);
  }
  const usedGates = new Set();

  // lifecycles
  const lifecycles = isObj(wf.lifecycles) ? wf.lifecycles : {};
  if ("lifecycles" in wf && (!isObj(wf.lifecycles) || !Object.keys(wf.lifecycles).length)) err("lifecycles", "must be a non-empty object");
  for (const [code, lc] of Object.entries(lifecycles)) {
    const p = `lifecycles.${code}`;
    if (!CODE.test(code)) err(p, "lifecycle code must start with a letter and use letters, digits, - or _");
    if (!isObj(lc)) { err(p, "must be an object"); continue; }
    unknownKeys(lc, ["name", "kind", "pickWhen", "exitArtifact", "segments", "stages", "note"], p);
    for (const k of ["name", "pickWhen", "exitArtifact"]) if (!isStr(lc[k])) err(p, `needs ${k}`);
    if (!KINDS.includes(lc.kind)) err(p, `kind must be ${KINDS.join(", ")}`);
    const hasSeg = "segments" in lc, hasStages = "stages" in lc;
    if (hasSeg === hasStages) { err(p, "needs exactly one of `segments` or `stages`"); continue; }
    if (hasSeg) {
      if (!isStrArr(lc.segments) || !lc.segments.length) { err(`${p}.segments`, "must be a non-empty array of lifecycle codes"); continue; }
      for (const s of lc.segments) {
        if (!(s in lifecycles)) err(`${p}.segments`, `"${s}" is not a defined lifecycle`);
        else if (s === code) err(`${p}.segments`, "a lifecycle cannot contain itself");
      }
      continue;
    }
    if (!Array.isArray(lc.stages) || !lc.stages.length) { err(`${p}.stages`, "must be a non-empty array"); continue; }
    const ids = new Set();
    lc.stages.forEach((st, i) => {
      const sp = `${p}.stages[${i}]${isObj(st) && typeof st.id === "string" ? ` (${st.id})` : ""}`;
      if (!isObj(st)) return err(sp, "must be an object");
      unknownKeys(st, STAGE_KEYS, sp);
      if (typeof st.id !== "string" || !ID.test(st.id)) err(sp, "id must be kebab-case");
      else if (ids.has(st.id)) err(sp, `duplicate stage id "${st.id}"`);
      else ids.add(st.id);
      if (!("agent" in st)) err(sp, "needs an agent"); else usedAgent(st.agent, `${sp}.agent`);
      for (const k of ["skills", "produces", "after"]) if (k in st && !isStrArr(st[k])) err(`${sp}.${k}`, "must be an array of strings");
      if (isStrArr(st.skills)) for (const k of st.skills) usedSkill(k, `${sp}.skills`);
      for (const k of ["skills", "after"]) if (isStrArr(st[k])) for (const d of dupes(st[k])) err(`${sp}.${k}`, `"${d}" is listed twice`);
      for (const k of ["when", "note"]) if (k in st && !isStr(st[k])) err(`${sp}.${k}`, "must be a non-empty string");
      if ("critique" in st && typeof st.critique !== "boolean") err(`${sp}.critique`, "must be true or false");
      if ("gate" in st) {
        if (!(st.gate in gates)) err(`${sp}.gate`, `gate "${st.gate}" is not defined in gates`);
        usedGates.add(st.gate);
      }
      if ("loop" in st) {
        if (!isObj(st.loop)) err(`${sp}.loop`, "must be an object { to, on, maxRounds? }");
        else {
          unknownKeys(st.loop, ["to", "on", "maxRounds"], `${sp}.loop`);
          if (!isStr(st.loop.to)) err(`${sp}.loop`, "needs `to` (the stage work returns to)");
          if (!isStr(st.loop.on)) err(`${sp}.loop`, "needs `on` (what sends work back)");
          if ("maxRounds" in st.loop && !(Number.isInteger(st.loop.maxRounds) && st.loop.maxRounds >= 1)) err(`${sp}.loop.maxRounds`, "must be a positive integer");
        }
      }
    });
    // references inside the lifecycle
    lc.stages.forEach((st, i) => {
      if (!isObj(st)) return;
      const sp = `${p}.stages[${i}] (${st.id})`;
      if (isStrArr(st.after)) for (const a of st.after) {
        if (!ids.has(a)) err(`${sp}.after`, `"${a}" is not a stage of ${code}`);
        else if (a === st.id) err(`${sp}.after`, "a stage cannot follow itself");
      }
      if (isObj(st.loop) && isStr(st.loop.to)) {
        if (!ids.has(st.loop.to)) err(`${sp}.loop.to`, `"${st.loop.to}" is not a stage of ${code}`);
      }
    });
    if (lc.stages.every(isObj)) {
      const cycle = findCycle(lc.stages);
      if (cycle) err(`${p}.stages`, `cycle in \`after\`: ${cycle.join(" -> ")}`);
      // "Builds code": a software-engineer stage that runs a build skill or produces a diff / fix / code.
      const builds = lc.stages.some((s) => s.agent === "software-engineer" &&
        ((isStrArr(s.skills) && s.skills.some((k) => ["implement-feature", "fix-bug"].includes(k))) || (isStrArr(s.produces) && /diff|fix|code|implement|refactor/i.test(s.produces.join(" ")))));
      const reviews = lc.stages.some((s) => s.agent === "code-reviewer");
      if (builds && !reviews) wrn(p, "builds code (a software-engineer stage) but has no code-reviewer stage");
    }
  }
  // composite cycles (A contains B contains A)
  for (const code of Object.keys(lifecycles)) {
    const seen = new Set();
    const visit = (c, trail) => {
      const lc = lifecycles[c];
      if (!isObj(lc) || !isStrArr(lc.segments)) return;
      for (const s of lc.segments) {
        if (s === code && trail.length) { err(`lifecycles.${code}.segments`, `composite cycle: ${[...trail, s].join(" -> ")}`); return; }
        if (!seen.has(s)) { seen.add(s); visit(s, [...trail, s]); }
      }
    };
    visit(code, [code]);
  }
  for (const g of Object.keys(gates)) if (!usedGates.has(g)) wrn(`gates.${g}`, "is defined but no stage uses it");

  // routing
  const r = wf.routing;
  if (isObj(r)) {
    unknownKeys(r, ["byType", "handOff", "routeImmediately"], "routing");
    if (!isObj(r.byType)) err("routing.byType", "must be an object { <request type>: <lifecycle code> }");
    else for (const [t, lc] of Object.entries(r.byType)) if (t !== "Agent Artifact" && !(lc in lifecycles)) err(`routing.byType.${t}`, `"${lc}" is not a defined lifecycle`);
    if (!isObj(r.handOff)) err("routing.handOff", "must be an object { <work kind>: <agent id> }");
    else {
      for (const [k, a] of Object.entries(r.handOff)) usedAgent(a, `routing.handOff["${k}"]`);
      if ("agent-artifact work" in r.handOff && r.handOff["agent-artifact work"] !== "agent-manager") err(`routing.handOff["agent-artifact work"]`, "must stay agent-manager (fixed guardrail)");
    }
    // The lifecycle agent-artifact work runs: agent-manager makes the change; brutal-critique reviews the
    // docs, sqa-engineer tests and code-reviewer reviews the code, each sending findings back to agent-manager.
    const aaw = isObj(r.byType) ? r.byType["Agent Artifact"] : undefined;
    const lc = typeof aaw === "string" ? lifecycles[aaw] : undefined;
    if (isObj(r.byType) && aaw === undefined) err(`routing.byType["Agent Artifact"]`, `missing: agent-artifact work needs its lifecycle (default "AAW": agent-manager, then brutal-critique for docs and sqa-engineer, code-reviewer for code) — run /ai-dlc:workflow upgrade to bring it in`);
    else if (isObj(r.byType) && !isObj(lc)) err(`routing.byType["Agent Artifact"]`, `lifecycle "${aaw}" is not defined — run /ai-dlc:workflow upgrade to bring in the default AAW`);
    else if (isObj(lc) && !Array.isArray(lc.stages)) err(`routing.byType["Agent Artifact"]`, `"${aaw}" must be a lifecycle with stages, not segments`);
    else if (isObj(lc) && lc.stages.length && lc.stages.every(isObj)) {
      const st = lc.stages;
      if (st.some((s, i) => afterOf(st, i).length === 0 && s.agent !== "agent-manager"))
        err(`lifecycles.${aaw}`, `agent-artifact work runs this lifecycle (routing.byType["Agent Artifact"]), so every starting stage must be agent-manager (fixed guardrail)`);
      // The rules are documented in the workflow skill's references/aaw-review.md.
      const reviews = st.filter((s) => typeof s.agent === "string" && Object.hasOwn(AAW_REVIEWERS, s.agent) && isObj(s.loop) && st.some((t) => t.id === s.loop.to && t.agent === "agent-manager"));
      for (const [agent, { why }] of Object.entries(AAW_REVIEWERS))
        if (!reviews.some((s) => s.agent === agent)) err(`lifecycles.${aaw}`, `needs a ${agent} stage that loops back to the agent-manager stage ${why} (fixed guardrail; run /ai-dlc:workflow upgrade to bring in the default AAW stages)`);
      const where = (s) => `lifecycles.${aaw}.stages[${st.indexOf(s)}] (${s.id})`;
      const budgets = new Map();
      // Only stages that already loop back to agent-manager are checked here; a review stage with no valid
      // loop is reported once, by the "needs a <agent> stage that loops back" error above.
      for (const s of reviews) {
        if (!Number.isInteger(s.loop.maxRounds) || s.loop.maxRounds < 1) err(`${where(s)}.loop.maxRounds`, "required on an AAW review loop: the review loops share one round budget (fixed guardrail)");
        else budgets.set(s.id, s.loop.maxRounds);
        // `when` is an exact phrase (case and spacing ignored), so a reworded condition cannot switch a review off.
        // `\s+` also collapses NBSP and other Unicode spaces on purpose (pinned by tests): never narrow it to ASCII spaces.
        const expected = AAW_REVIEWERS[s.agent].when;
        if ("when" in s && (typeof s.when !== "string" || s.when.trim().replace(/\s+/g, " ").toLowerCase() !== expected))
          err(`${where(s)}.when`, `must be "${expected}" (case and spacing ignored), or be omitted so the stage runs on every change (fixed guardrail)`);
      }
      if (new Set(budgets.values()).size > 1)
        err(`lifecycles.${aaw}`, `the review loops share one round budget, so their maxRounds must be equal (${[...budgets].map(([id, n]) => `${id} ${n}`).join(", ")}) (fixed guardrail)`);
      // code-review must name the sqa-engineer stage in its own `after` (directly, not through another stage).
      const testIds = reviews.filter((s) => s.agent === "sqa-engineer").map((s) => s.id);
      for (const s of reviews.filter((x) => x.agent === "code-reviewer"))
        if (testIds.length && !afterOf(st, st.indexOf(s)).some((x) => testIds.includes(x)))
          err(`${where(s)}.after`, `must include the sqa-engineer stage (${testIds.join(" or ")}): code is reviewed with its tests (fixed guardrail)`);
    }
    if (!isStrArr(r.routeImmediately)) err("routing.routeImmediately", "must be an array of request types");
    else for (const d of dupes(r.routeImmediately)) err("routing.routeImmediately", `"${d}" is listed twice`);
  } else if ("routing" in wf) err("routing", "must be an object");

  // clarify
  const c = wf.clarify;
  if (isObj(c)) {
    unknownKeys(c, ["maxRounds", "matrix"], "clarify");
    if (!(Number.isInteger(c.maxRounds) && c.maxRounds >= 1)) err("clarify.maxRounds", "must be a positive integer");
    if (!isObj(c.matrix)) err("clarify.matrix", "must be an object { <asker>: [{ agent, about }] }");
    else for (const [asker, rows] of Object.entries(c.matrix)) {
      const p = `clarify.matrix.${asker}`;
      usedAgent(asker, p);
      if (!Array.isArray(rows)) { err(p, "must be an array of { agent, about }"); continue; }
      rows.forEach((row, i) => {
        if (!isObj(row)) return err(`${p}[${i}]`, "must be { agent, about }");
        unknownKeys(row, ["agent", "about"], `${p}[${i}]`);
        usedAgent(row.agent, `${p}[${i}].agent`, { human: true });
        if (row.agent === asker) err(`${p}[${i}].agent`, "an agent cannot consult itself");
        if (!isStr(row.about)) err(`${p}[${i}]`, "needs `about`");
      });
    }
  } else if ("clarify" in wf) err("clarify", "must be an object");

  // documents, review, artifacts
  const d = wf.documents;
  if (isObj(d)) {
    unknownKeys(d, ["writer", "critic"], "documents");
    usedAgent(d.writer, "documents.writer");
    if (d.critic === null) wrn("documents.critic", "is null — documents reach gates without critique");
    else usedAgent(d.critic, "documents.critic");
  } else if ("documents" in wf) err("documents", "must be an object");
  if (isObj(wf.review)) {
    unknownKeys(wf.review, ["axes"], "review");
    if (!isStrArr(wf.review.axes) || !wf.review.axes.length) err("review.axes", "must be a non-empty array");
    else {
      for (const a of wf.review.axes) if (!AXES.includes(a)) err("review.axes", `"${a}" is not an axis (${AXES.join(", ")})`);
      for (const d of dupes(wf.review.axes)) err("review.axes", `"${d}" is listed twice`);
    }
  } else if ("review" in wf) err("review", "must be an object");
  if (isObj(wf.artifacts)) {
    unknownKeys(wf.artifacts, ARTIFACTS, "artifacts");
    for (const k of ARTIFACTS) if (!isStr(wf.artifacts[k])) err(`artifacts.${k}`, "must be a non-empty path");
  } else if ("artifacts" in wf) err("artifacts", "must be an object");

  return { errors, warnings };
}

// `after` defaults to the previous stage; [] starts the lifecycle.
const afterOf = (stages, i) => Array.isArray(stages[i].after) ? stages[i].after : i === 0 ? [] : [stages[i - 1].id];

function findCycle(stages) {
  const graph = new Map(stages.map((s, i) => [s.id, afterOf(stages, i).filter((a) => stages.some((x) => x.id === a))]));
  const state = new Map(); // 1 visiting, 2 done
  const stack = [];
  const dfs = (n) => {
    state.set(n, 1); stack.push(n);
    for (const m of graph.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m].reverse();
      if (!state.has(m)) { const c = dfs(m); if (c) return c; }
    }
    state.set(n, 2); stack.pop();
    return null;
  };
  for (const n of graph.keys()) if (!state.has(n)) { const c = dfs(n); if (c) return c; }
  return null;
}

// ---- show -----------------------------------------------------------------------
function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const line = (r) => `| ${r.map((c, i) => String(c).padEnd(w[i])).join(" | ")} |`;
  return [line(rows[0]), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}

function show(wf, only, mermaid) {
  const codes = only ? [only] : Object.keys(wf.lifecycles);
  if (only && !(only in wf.lifecycles)) usage(`no lifecycle "${only}" (have ${Object.keys(wf.lifecycles).join(", ")})`);
  const out = [];
  for (const code of codes) {
    const lc = wf.lifecycles[code];
    if (mermaid) { out.push(`### ${code} · ${lc.name}`, "", "```mermaid", ...flowchart(wf, code), "```", ""); continue; }
    out.push(`## ${code} · ${lc.name} (${lc.kind})`, `Pick when: ${lc.pickWhen}`, `Exit artifact: ${lc.exitArtifact}`);
    if (lc.note) out.push(`Note: ${lc.note}`);
    if (lc.segments) {
      out.push(`Segments: ${lc.segments.map((s) => { const g = lastGate(wf, s); return g ? `${s} -> ${g}` : s; }).join(" -> ")}`, "");
      continue;
    }
    const rows = [["stage", "agent", "after", "when", "gate", "loop"]];
    lc.stages.forEach((st, i) => {
      const after = afterOf(lc.stages, i);
      rows.push([
        st.id + (st.critique && wf.documents.critic ? " *" : ""),
        st.agent,
        after.length ? after.join(", ") : "(start)",
        st.when ?? "",
        st.gate ? `${st.gate} (${wf.gates[st.gate]?.approver ?? "?"})` : "",
        st.loop ? `-> ${st.loop.to}${st.loop.maxRounds ? ` x${st.loop.maxRounds}` : ""}` : "",
      ]);
    });
    out.push("", table(rows));
    if (lc.stages.some((s) => s.critique) && wf.documents.critic) out.push(`* documents written by ${wf.documents.writer}, critiqued by ${wf.documents.critic} in parallel`);
    out.push("");
  }
  if (!mermaid && !only) {
    out.push("## Gates", "", table([["gate", "name", "approver", "approves"], ...Object.entries(wf.gates).map(([g, d]) => [g, d.name, d.approver, d.approves])]), "");
    const dis = wf.agents.disabled.length ? wf.agents.disabled.join(", ") : "none";
    const cus = Object.keys(wf.agents.custom).length ? Object.keys(wf.agents.custom).join(", ") : "none";
    out.push(`Disabled agents: ${dis} · Custom agents: ${cus} · Clarify: max ${wf.clarify.maxRounds} rounds · Review axes: ${wf.review.axes.join(", ")}`);
  }
  console.log(out.join("\n").trimEnd());
}

function lastGate(wf, code) {
  const lc = wf.lifecycles[code];
  if (!lc) return null;
  if (lc.segments) return lastGate(wf, lc.segments.at(-1));
  return lc.stages.findLast((s) => s.gate)?.gate ?? null;
}

const nid = (s) => s.replace(/[^A-Za-z0-9_]/g, "_");
const label = (s) => s.replace(/"/g, "#quot;");

function flowchart(wf, code) {
  const lc = wf.lifecycles[code];
  const out = ["flowchart LR"];
  if (lc.segments) {
    const parts = ["start((start))"];
    for (const s of lc.segments) {
      const g = lastGate(wf, s);
      parts.push(`seg_${nid(s)}["${label(s)}<br/>${label(wf.lifecycles[s]?.name ?? "?")}"]`);
      if (g) parts.push(`gate_${nid(s)}{{"${label(g)} · ${wf.gates[g]?.approver ?? "?"}"}}`);
    }
    parts.push("finish((done))");
    out.push(`  ${parts.join(" --> ")}`);
    return out;
  }
  const st = lc.stages;
  const succ = new Map(st.map((s) => [s.id, []]));
  st.forEach((s, i) => { for (const a of afterOf(st, i)) succ.get(a)?.push(s.id); });
  out.push("  start((start))", "  finish((done))");
  for (const s of st) {
    // A conditional stage (`when`) is drawn as a parallelogram with its condition.
    const text = `${label(s.id)}<br/>${label(s.agent)}${s.when ? `<br/><i>if ${label(s.when)}</i>` : ""}`;
    out.push(`  ${nid(s.id)}${s.when ? `[/"${text}"/]` : `["${text}"]`}`);
    if (s.gate) out.push(`  gate_${nid(s.id)}{{"${label(s.gate)} · ${wf.gates[s.gate]?.approver ?? "?"}"}}`);
  }
  st.forEach((s, i) => { if (afterOf(st, i).length === 0) out.push(`  start --> ${nid(s.id)}`); });
  for (const s of st) {
    const from = s.gate ? `gate_${nid(s.id)}` : nid(s.id);
    if (s.gate) out.push(`  ${nid(s.id)} --> ${from}`);
    const next = succ.get(s.id);
    if (!next.length) out.push(`  ${from} --> finish`);
    for (const n of next) out.push(`  ${from} --> ${nid(n)}`);
  }
  for (const s of st) if (s.loop) out.push(`  ${nid(s.id)} -.->|"${label(s.loop.on.length > 48 ? `${s.loop.on.slice(0, 45)}...` : s.loop.on)}"| ${nid(s.loop.to)}`);
  return out;
}

// ---- diff -----------------------------------------------------------------------
// Stages are compared by id and clarify rows by agent, not position, so a reordered or inserted
// entry reads as one change.
function normalise(v) {
  if (Array.isArray(v)) {
    const byAgent = v.length && v.every((x) => isObj(x) && typeof x.agent === "string") && new Set(v.map((x) => x.agent)).size === v.length;
    return byAgent ? Object.fromEntries(v.map((x) => [x.agent, x.about ?? normalise(x)])) : v.map(normalise);
  }
  if (!isObj(v)) return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "stages" && Array.isArray(x) && x.every((s) => isObj(s) && typeof s.id === "string")) {
      o.stages = Object.fromEntries(x.map((s) => [s.id, normalise(s)]));
      o["stage order"] = x.map((s) => s.id);
    } else o[k] = normalise(x);
  }
  return o;
}

function diff(a, b, p, out) {
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const q = p ? `${p}.${k}` : k;
      if (!(k in b)) out.push(`- only in project: ${q} = ${short(a[k])}`);
      else if (!(k in a)) out.push(`+ only in other:   ${q} = ${short(b[k])}`);
      else diff(a[k], b[k], q, out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`~ changed:         ${p}: ${short(a)} (project) vs ${short(b)} (other)`);
  return out;
}
const short = (v) => { const s = JSON.stringify(v); return s.length > 100 ? `${s.slice(0, 97)}...` : s; };

// ---- main -----------------------------------------------------------------------
if (COMMAND === "catalog") {
  if (!opt("--plugin")) usage("catalog needs --plugin <plugin root> (the folder with agents/ and skills/)");
  const out = path.resolve(opt("--out") ?? path.join(ROOT, ".ai-dlc", "catalog.json"));
  const c = buildCatalog(opt("--plugin"));
  const doc = { $comment: "Generated by `workflow.mjs catalog` from the installed AI-DLC plugin. Do not edit; /ai-dlc:workflow upgrade regenerates it.", ...c };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${path.relative(process.cwd(), out) || out}: ${c.plugin.name} ${c.plugin.version ?? "(no version)"} · ${c.agents.length} agents · ${c.skills.length} skills`);
  process.exit(0);
}

const wf = load(FILE);
const relFile = path.relative(process.cwd(), FILE) || FILE;
const catalog = loadCatalog();

if (COMMAND === "validate") {
  const { errors, warnings } = validate(wf, catalog);
  if (opt("--plugin") && fs.existsSync(CATALOG_FILE)) {
    // A corrupt stored catalog is only a warning here: --plugin supplies the catalog for this run.
    let stored = null;
    const rel = path.relative(process.cwd(), CATALOG_FILE) || CATALOG_FILE;
    try { stored = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")); } catch { warnings.push(`catalog: ${rel} is not valid JSON — run /ai-dlc:workflow upgrade to regenerate it`); }
    if (stored && stored.plugin?.version !== catalog.plugin.version)
      warnings.push(`catalog: ${rel} is for plugin version ${stored?.plugin?.version ?? "(unknown)"}, the plugin at --plugin is ${catalog.plugin.version ?? "(no version)"} — run /ai-dlc:workflow upgrade to regenerate it`);
  }
  if (!catalog) errors.unshift(`catalog: ${path.relative(process.cwd(), CATALOG_FILE) || CATALOG_FILE} is missing, so plugin agents and skills cannot be checked — run /ai-dlc:workflow upgrade to generate it (repositories set up before the catalog existed need this once; a new setup runs /ai-dlc:workflow install)`);
  for (const e of errors) console.log(`error: ${e}`);
  for (const w of warnings) console.log(`warning: ${w}`);
  console.log(errors.length ? `${relFile}: ${errors.length} error(s), ${warnings.length} warning(s)` : `${relFile}: valid${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
  process.exit(errors.length ? 1 : 0);
}

if (COMMAND === "show") {
  const { errors } = validate(wf, catalog);
  if (errors.length) {
    for (const e of errors) console.log(`error: ${e}`);
    console.log(`${relFile} is invalid; fix it before showing it (node .ai-dlc/workflow.mjs validate).`);
    process.exit(1);
  }
  show(wf, positional[1], argv.includes("--mermaid"));
  process.exit(0);
}

if (COMMAND === "diff") {
  const against = opt("--against");
  if (!against) usage("diff needs --against <path>");
  const lines = diff(normalise(wf), normalise(load(path.resolve(against))), "", []);
  console.log(lines.length ? lines.join("\n") : "no differences");
  if (lines.length) console.log(`${lines.length} difference(s) between ${relFile} (project) and ${path.relative(process.cwd(), path.resolve(against))} (other)`);
  process.exit(lines.length ? 1 : 0);
}
