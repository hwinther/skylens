// Turns the Maestro output directory of .github/workflows/android-e2e.yml (report.xml, the per-flow
// artifacts/<timestamp>/<flow>/{commands.json,logs/maestro.log}, logcat.txt, sim-diag.txt,
// maestro-exit-code) into a short Markdown summary for the job summary and the PR comment: the
// result, a table of flows and, for a failure, the failing step, the steps before it, device-level
// ANRs/crashes/app deaths and the cockpit globe's last diagnostics.
//
//   node .maestro/scripts/maestro-summary.mjs <maestro-out> [--output summary.md]
//
// Optional environment (any of it may be missing):
//   MAESTRO_STEP_OUTCOME  outcome of the emulator/Maestro step (success|failure|skipped|cancelled)
//   SUMMARY_SHA           commit SHA;  SUMMARY_RUN_URL  link to the run;  SUMMARY_ARTIFACT  artifact name
//   MAESTRO_APP_ID        app package, when the flows' commands.json don't name it
//
// Everything read from the output directory is device or PR output, so it is treated as untrusted:
// it only reaches the Markdown through text()/code(), which strip control characters, cap the length
// and neutralise markup, links, @mentions and #references. Never throws and always exits 0: a missing
// or partial directory (the emulator can die before anything is written) is reported, not fatal.
// Tests: `npm run test:scripts` in app/ (node --test).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_APP_ID = "no.wsh.skylens";
const TITLE = "Android E2E (Maestro)";
const MAX_MARKDOWN = 60000; // GitHub comments cap at 65536 characters
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_FINDINGS = 8;
const CONTEXT_STEPS = 3;
const MAX_FAILED_FLOWS = 5;
// Bookkeeping commands that say nothing about where a flow was.
const QUIET_COMMANDS = new Set(["applyConfigurationCommand", "defineVariablesCommand"]);

// ---------------------------------------------------------------------------------------------
// Escaping: all untrusted text goes through code() or text().

/** One line, no control/zero-width/bidi characters, at most `max` characters. */
export function clean(value, max = 300) {
  let s = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return s;
}

/** Inline code span: GitHub renders no HTML, links, mentions or references inside one. */
export function code(value, max = 300, { inTable = false } = {}) {
  let s = clean(value, max).replace(/`/g, "'");
  if (!s) return "";
  if (inTable) s = s.replace(/\|/g, "\\|");
  return `\`${s}\``;
}

/** Plain text: Markdown punctuation escaped; autolinks, @mentions and #references broken. */
export function text(value, max = 200) {
  return clean(value, max)
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&"=:/]/g, "\\$&")
    // GitHub links @mentions, #references and bare URLs in the rendered text, after the Markdown
    // escapes are gone, so those get a zero-width space instead.
    .replace(/@/g, "@\u200b")
    .replace(/\\#/g, "\\#\u200b")
    .replace(/\\:\\\/\\\//g, "\\:\u200b\\/\\/")
    .replace(/www\\\./gi, "www\u200b\\.");
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function readText(file) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const buf = readFileSync(file);
    // Only a log's tail matters when it is huge.
    return (buf.length > MAX_READ_BYTES ? buf.subarray(buf.length - MAX_READ_BYTES) : buf).toString("utf8");
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function decodeXml(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[k];
    if (named) return named;
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = decodeXml(m[3] ?? m[4]);
  }
  return out;
}

/** 5.2 s / 3m 28s / 1h 02m */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------------------------
// report.xml (JUnit)

/** @returns {{ suite: { time: number, timestamp: string }, flows: object[] } | null} */
export function parseReport(xml) {
  if (typeof xml !== "string" || !/<testsuite[\s>]/.test(xml)) return null;
  const suiteTag = xml.match(/<testsuite\b[^>]*>/);
  const sa = suiteTag ? attrs(suiteTag[0]) : {};
  const flows = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]);
    const body = m[3] ?? "";
    const failure = body.match(/<(failure|error)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/);
    const status = String(a.status ?? "").toUpperCase();
    let result;
    if (failure || ["ERROR", "FAILURE", "FAILED"].includes(status)) result = "failed";
    else if (/<skipped\b/.test(body) || status === "SKIPPED") result = "skipped";
    else if (["", "SUCCESS", "PASSED"].includes(status)) result = "passed";
    else result = status.toLowerCase();
    let message = "";
    if (failure) {
      message = decodeXml((failure[2] ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
      if (!message.trim()) message = attrs(failure[0]).message ?? "";
    }
    flows.push({
      name: a.name ?? a.id ?? "(unnamed flow)",
      file: a.file ?? "",
      time: Number.parseFloat(a.time),
      result,
      message,
    });
  }
  return { suite: { time: Number.parseFloat(sa.time), timestamp: sa.timestamp ?? "" }, flows };
}

// ---------------------------------------------------------------------------------------------
// Per-flow artifacts: commands.json + logs/maestro.log

function readCommands(flowDir) {
  const raw = readText(path.join(flowDir, "commands.json"));
  if (raw == null) return null;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function commandKind(entry) {
  const c = entry?.command;
  return c && typeof c === "object" ? (Object.keys(c)[0] ?? "") : "";
}

function flowNameOf(commands) {
  for (const e of commands ?? []) {
    const name = e?.command?.applyConfigurationCommand?.config?.name;
    if (typeof name === "string") return name;
  }
  return null;
}

/** The app package the flow launched (launchApp / appId config), if any. */
export function appIdOf(commands) {
  for (const e of commands ?? []) {
    const c = e?.command ?? {};
    const id = c.launchAppCommand?.appId ?? c.applyConfigurationCommand?.config?.appId;
    if (typeof id === "string" && /^[\w.]+$/.test(id)) return id;
  }
  return null;
}

/** Finds artifacts/<timestamp>/<flow name>/ (the newest timestamp that has it). */
export function findFlowDir(outDir, flowName) {
  const root = path.join(outDir, "artifacts");
  const stamps = listDirs(root).reverse();
  for (const stamp of stamps) {
    const dir = path.join(root, stamp, flowName);
    if (!flowName.includes("..") && isDir(dir)) return dir;
  }
  // Fall back to the name in commands.json, in case Maestro sanitised the directory name.
  for (const stamp of stamps) {
    for (const d of listDirs(path.join(root, stamp))) {
      const dir = path.join(root, stamp, d);
      if (flowNameOf(readCommands(dir)) === flowName) return dir;
    }
  }
  return null;
}

/** maestro.log's "onCommandStart: <description> RUNNING" lines: one per command, in commands.json order. */
export function parseMaestroLog(log) {
  const starts = [];
  if (typeof log !== "string") return starts;
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^(\d\d:\d\d:\d\d)(?:\.\d+)?\s.*?CliConsoleListener\.onCommandStart: (.*) RUNNING\s*$/);
    if (m) starts.push({ time: m[1], description: m[2] });
  }
  return starts;
}

/** A readable fallback when maestro.log has no description for a command. */
function describeCommand(entry) {
  const kind = commandKind(entry);
  const body = entry?.command?.[kind] ?? {};
  const sel = body.selector ?? body.condition?.visible ?? body.condition?.notVisible ?? {};
  const target = sel.idRegex ? `id: ${sel.idRegex}` : sel.textRegex ? `"${sel.textRegex}"` : "";
  return [kind.replace(/Command$/, ""), target].filter(Boolean).join(" ") || "(unknown command)";
}

function stepOf(entry, index, starts) {
  const meta = entry?.metadata ?? {};
  const seq = Number.isInteger(meta.sequenceNumber) ? meta.sequenceNumber : index;
  const logged = starts[seq];
  return {
    number: seq + 1, // Maestro names the step's screenshot step-<seq+1>-…
    description: logged?.description ?? describeCommand(entry),
    started: logged?.time ?? "",
    status: String(meta.status ?? ""),
    duration: Number(meta.duration) / 1000,
    depth: Number.isInteger(meta.depth) ? meta.depth : 0,
    error: meta.error?.message ?? "",
    kind: commandKind(entry),
  };
}

/**
 * The failing step (the deepest FAILED command), the top-level step it ran inside (if nested) and
 * the last few completed top-level steps before it. `last` is the last recorded step either way.
 */
export function analyseFlow(commands, log) {
  if (!Array.isArray(commands) || commands.length === 0) return null;
  const starts = parseMaestroLog(log);
  const steps = commands.map((e, i) => stepOf(e, i, starts));
  let failIdx = -1;
  steps.forEach((s, i) => {
    if (s.status === "FAILED" && (failIdx < 0 || s.depth >= steps[failIdx].depth)) failIdx = i;
  });
  const last = steps.at(-1);
  if (failIdx < 0) return { failing: null, parent: null, before: [], last };
  const failing = steps[failIdx];
  let parentIdx = -1;
  if (failing.depth > 0) {
    for (let i = failIdx - 1; i >= 0; i--) {
      if (steps[i].depth === 0) {
        parentIdx = i;
        break;
      }
    }
  }
  const before = steps
    .slice(0, parentIdx >= 0 ? parentIdx : failIdx)
    .filter((s) => s.depth === 0 && s.status === "COMPLETED" && !QUIET_COMMANDS.has(s.kind))
    .slice(-CONTEXT_STEPS);
  return { failing, parent: parentIdx >= 0 ? steps[parentIdx] : null, before, last };
}

// ---------------------------------------------------------------------------------------------
// Device findings (logcat events buffer)

/** "2026-11-13T21:16:23" → "11-13 21:16:23" (logcat's clock; both are UTC on the CI runner). */
export function logcatStamp(isoTimestamp) {
  const m = String(isoTimestamp ?? "").match(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d:\d\d)/);
  return m ? `${m[1]}-${m[2]} ${m[3]}` : "";
}

function isAppProcess(proc, appId) {
  return proc === appId || proc.startsWith(`${appId}:`);
}

/**
 * am_anr / am_crash (any process) and am_proc_died (the app only) from logcat, at or after `since`
 * ("MM-DD HH:MM:SS", the flows' start), so a fresh emulator's boot-time noise is left out.
 */
export function parseDeviceEvents(logcat, appId, since = "") {
  const events = [];
  if (typeof logcat !== "string") return events;
  const re = /^(\d\d-\d\d (\d\d:\d\d:\d\d))\.\d+\s+\d+\s+\d+\s+\w\s+(am_anr|am_crash|am_proc_died)\s*:\s*\[(.*)\]\s*$/;
  for (const line of logcat.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m || (since && m[1] < since)) continue;
    const f = m[4].split(",");
    const proc = f[2] ?? "";
    const app = isAppProcess(proc, appId);
    const time = m[2];
    if (m[3] === "am_anr") {
      // [user, pid, process, flags, reason]
      events.push({ type: "anr", time, process: proc, app, reason: f.slice(4).join(",") });
    } else if (m[3] === "am_crash") {
      // [pid, user, process, flags, exception, message, file, line, recoverable]
      const msg = (f.length > 8 ? f.slice(5, f.length - 3) : f.slice(5)).join(",");
      events.push({ type: "crash", time, process: proc, app, reason: [f[4], msg].filter(Boolean).join(": ") });
    } else if (app) {
      // [user, pid, process, oomadj, procstate]
      events.push({ type: "died", time, process: proc, app, reason: "" });
    }
  }
  return events;
}

function findingLines(events) {
  const lines = [];
  for (const e of events.slice(0, MAX_FINDINGS)) {
    const who = e.app ? `the app (${code(e.process, 120)})` : `system process ${code(e.process, 120)}`;
    if (e.type === "anr") lines.push(`- ANR in ${who} at ${e.time}: ${code(e.reason, 200)}`);
    else if (e.type === "crash") lines.push(`- Crash in ${who} at ${e.time}: ${code(e.reason, 200)}`);
    else lines.push(`- The app process ${code(e.process, 120)} died at ${e.time}`);
  }
  if (events.length > MAX_FINDINGS) lines.push(`- … and ${events.length - MAX_FINDINGS} more (see logcat.txt)`);
  if (events.some((e) => /GPU hang|stuck fence/i.test(e.reason))) {
    lines.push(
      '- **Note:** the emulator\'s GPU hung ("stuck fence"). That is the emulator\'s rendering, not the app; failures after it are most likely a consequence.',
    );
  } else if (events.some((e) => e.type === "anr" && !e.app)) {
    lines.push(
      "- **Note:** a system (non-app) process went ANR, which on CI usually means the emulator was starved or hung rather than a bug in the app.",
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sim-diag.txt

/**
 * The flow's own "SkylensSim globe = …" / "SkylensSim diag = gl=…|px=…" lines (Maestro's JsConsole),
 * else the last "SkylensSim gl=…" line the app logged itself. sim-diag.txt is not in time order
 * (per-flow logs first, then logcat), so the flow's lines win over the device's.
 */
export function lastGlobeDiag(simDiag) {
  let globe = "";
  let diag = "";
  let deviceDiag = "";
  if (typeof simDiag !== "string") return { globe, diag };
  for (const line of simDiag.split(/\r?\n/)) {
    // The flow's YAML / command echo: console.log('SkylensSim diag = ' + maestro.copiedText).
    if (line.includes("maestro.copiedText")) continue;
    const g = line.match(/SkylensSim globe = (.*)$/);
    if (g) globe = g[1];
    const d = line.match(/SkylensSim diag = (.*)$/);
    if (d) diag = d[1];
    const n = line.match(/SkylensSim (gl=[^"]*)/);
    if (n) deviceDiag = n[1];
  }
  return { globe, diag: diag || deviceDiag };
}

// ---------------------------------------------------------------------------------------------
// Rendering

const ICON = { passed: "✅", failed: "❌", skipped: "⏭️" };

function metaLine({ sha, runUrl, artifact }) {
  const parts = [];
  if (/^[0-9a-f]{7,40}$/i.test(sha ?? "")) parts.push(`Commit \`${sha.slice(0, 7)}\``);
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/.test(runUrl ?? "")) {
    parts.push(`[workflow run](${runUrl})`);
  }
  if (/^[\w.-]{1,100}$/.test(artifact ?? "")) parts.push(`artifact \`${artifact}\` (screenshots, logs)`);
  return parts.join(" · ");
}

function flowTable(flows) {
  const rows = ["| Flow | File | Result | Time |", "| --- | --- | --- | --- |"];
  for (const f of flows) {
    rows.push(
      `| ${text(f.name, 120)} | ${code(f.file, 120, { inTable: true })} | ${ICON[f.result] ?? "⚠️"} ${text(f.result, 20)} | ${formatDuration(f.time)} |`,
    );
  }
  return rows.join("\n");
}

function failedFlowDetails(outDir, flow, appId) {
  const lines = [`#### ❌ ${text(flow.name, 120)}${flow.file ? ` (${code(flow.file, 120)})` : ""}`, ""];
  const dir = findFlowDir(outDir, flow.name);
  const commands = dir ? readCommands(dir) : null;
  const analysis = analyseFlow(commands, dir ? readText(path.join(dir, "logs", "maestro.log")) : null);
  const message = flow.message || analysis?.failing?.error || "";
  if (message) lines.push(`- **Failure:** ${code(message, 300)}`);
  if (analysis?.failing) {
    const s = analysis.failing;
    const parts = [`step ${s.number}`, code(s.description, 200)];
    if (analysis.parent) parts.push(`inside ${code(analysis.parent.description, 120)}`);
    if (s.started) parts.push(`started ${s.started}`);
    if (Number.isFinite(s.duration)) parts.push(`failed after ${formatDuration(s.duration)}`);
    lines.push(`- **Failing step:** ${parts.join(", ")}`);
    if (analysis.before.length) {
      lines.push("- **Steps before it:**");
      for (const b of analysis.before) {
        const took = Number.isFinite(b.duration) ? ` (${formatDuration(b.duration)})` : "";
        lines.push(`  - ${b.number}: ${code(b.description, 160)}${took}`);
      }
    }
  } else if (analysis?.last) {
    lines.push(`- No failed step recorded; the last one was step ${analysis.last.number} ${code(analysis.last.description, 200)} (${text(analysis.last.status.toLowerCase() || "unknown", 20)}).`);
  } else if (!dir) {
    lines.push("- No per-flow artifacts (commands.json, maestro.log) for this flow.");
  } else {
    lines.push("- commands.json is missing or unreadable for this flow.");
  }
  return { lines, appId: appIdOf(commands) ?? appId };
}

/** Without a report.xml: what each flow's commands.json got to, if anything. */
function partialFlowLines(outDir) {
  const lines = [];
  let appId = null;
  const root = path.join(outDir, "artifacts");
  for (const stamp of listDirs(root)) {
    for (const d of listDirs(path.join(root, stamp))) {
      const dir = path.join(root, stamp, d);
      const commands = readCommands(dir);
      appId = appIdOf(commands) ?? appId;
      const a = analyseFlow(commands, readText(path.join(dir, "logs", "maestro.log")));
      const step = a?.failing ?? a?.last;
      if (!step) continue;
      const err = a.failing?.error ? `: ${code(a.failing.error, 200)}` : "";
      lines.push(`- ${text(d, 120)}: last step ${step.number} ${code(step.description, 200)} ${text(step.status.toLowerCase() || "unknown", 20)}${err}`);
    }
  }
  return { lines, appId };
}

/**
 * @param {string} outDir the Maestro output directory
 * @param {{ outcome?: string, sha?: string, runUrl?: string, artifact?: string, appId?: string }} [opts]
 * @returns {string} Markdown
 */
export function renderSummary(outDir, opts = {}) {
  const outcome = String(opts.outcome ?? "").toLowerCase();
  const meta = metaLine(opts);
  const out = [];
  const dirExists = Boolean(outDir) && isDir(outDir);

  const report = dirExists ? parseReport(readText(path.join(outDir, "report.xml"))) : null;
  const exitCode = dirExists ? (readText(path.join(outDir, "maestro-exit-code")) ?? "").trim() : "";
  const flows = report?.flows ?? [];
  const failed = flows.filter((f) => f.result === "failed");
  const totalTime = Number.isFinite(report?.suite.time)
    ? report.suite.time
    : flows.reduce((t, f) => t + (Number.isFinite(f.time) ? f.time : 0), 0);
  const flowCount = (n) => `${n} ${n === 1 ? "flow" : "flows"}`;

  if (flows.length > 0 && failed.length === 0 && !exitCode && outcome !== "failure") {
    out.push(`### ✅ ${TITLE}: ${flowCount(flows.length)} passed in ${formatDuration(totalTime)}`);
    if (meta) out.push("", meta);
    out.push("", flowTable(flows));
    return finish(out);
  }

  // Everything below is a failure, or a run that never got to a result.
  if (flows.length > 0) {
    const what = failed.length
      ? `${failed.length} of ${flowCount(flows.length)} failed`
      : `the run failed although every flow in report.xml passed`;
    out.push(`### ❌ ${TITLE}: ${what} (${formatDuration(totalTime)})`);
  } else if (!dirExists && outcome !== "failure") {
    out.push(`### ❌ ${TITLE}: the flows did not run`);
  } else {
    out.push(`### ❌ ${TITLE}: no result`);
  }
  if (meta) out.push("", meta);

  if (!dirExists) {
    out.push(
      "",
      outcome === "failure"
        ? "There is no Maestro output: the emulator step failed before Maestro wrote anything. See the job log."
        : "There is no Maestro output: the emulator step did not run because an earlier step (build, install) failed. See the job log.",
    );
    return finish(out);
  }

  const missing = [];
  if (!report) missing.push("report.xml");
  else if (flows.length === 0) missing.push("test cases in report.xml");

  let appId = opts.appId || DEFAULT_APP_ID;
  if (flows.length) out.push("", flowTable(flows));
  for (const f of failed.slice(0, MAX_FAILED_FLOWS)) {
    const d = failedFlowDetails(outDir, f, appId);
    appId = d.appId;
    out.push("", ...d.lines);
  }
  if (failed.length > MAX_FAILED_FLOWS) {
    out.push("", `… and ${failed.length - MAX_FAILED_FLOWS} more failed flows (see report.xml).`);
  }
  if (flows.length === 0) {
    const partial = partialFlowLines(outDir);
    appId = partial.appId ?? appId;
    if (partial.lines.length) out.push("", "Flows started (from their commands.json):", "", ...partial.lines);
  }
  if (exitCode && failed.length === 0) out.push("", `Maestro exit code: ${code(exitCode, 10)}.`);

  const logcat = readText(path.join(outDir, "logcat.txt"));
  if (logcat == null) missing.push("logcat.txt");
  const events = parseDeviceEvents(logcat, appId, logcatStamp(report?.suite.timestamp));
  if (events.length) out.push("", "#### Device (logcat, since the flows started)", "", ...findingLines(events));

  const { globe, diag } = lastGlobeDiag(readText(path.join(outDir, "sim-diag.txt")));
  if (globe || diag) {
    out.push("", "#### Cockpit globe (last diagnostics)", "");
    if (globe) out.push(`- ${code(globe, 160)}`);
    if (diag) out.push(`- ${code(diag, 300)}`);
  }

  if (missing.length) {
    out.push(
      "",
      `Missing from the output: ${missing.map((m) => text(m, 60)).join(", ")} (the emulator or Maestro may have stopped early; see the job log).`,
    );
  }
  return finish(out);
}

function finish(lines) {
  let md = `${lines.join("\n").trimEnd()}\n`;
  if (md.length > MAX_MARKDOWN) md = `${md.slice(0, MAX_MARKDOWN - 40)}\n\n… (summary truncated)\n`;
  return md;
}

// ---------------------------------------------------------------------------------------------
// CLI

export function main(argv, env) {
  const args = argv.slice(2);
  let output = "";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") output = args[++i] ?? "";
    else positional.push(args[i]);
  }
  const outDir = positional[0] ?? env.MAESTRO_OUT ?? "";
  let md;
  try {
    md = renderSummary(outDir, {
      outcome: env.MAESTRO_STEP_OUTCOME,
      sha: env.SUMMARY_SHA,
      runUrl: env.SUMMARY_RUN_URL,
      artifact: env.SUMMARY_ARTIFACT,
      appId: env.MAESTRO_APP_ID,
    });
  } catch (err) {
    md = `### ⚠️ ${TITLE}: could not build the summary\n\n${code(err?.message ?? err, 300)}\n`;
  }
  try {
    if (output) writeFileSync(output, md);
    else process.stdout.write(md);
  } catch (err) {
    console.error(`maestro-summary: could not write the summary: ${err?.message ?? err}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv, process.env);
}
