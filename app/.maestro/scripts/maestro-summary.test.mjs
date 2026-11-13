// node --test for maestro-summary.mjs (`npm run test:scripts` in app/). The fixtures are cut down from
// two real failing CI runs: element-not-found (the cockpit flow could not find sim-filter, no crash)
// and gpu-hang (the emulator's GPU hung: SystemUI and the app went ANR, then the app process died).
// A fixture keeps the cockpit flow's commands.json and maestro.log (as maestro-log.txt) flat in
// cockpit-flow/, since the repo's .gitignore drops artifacts/ and *.log; fixture() lays it out like
// Maestro's output in a temp dir.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyseFlow,
  code,
  lastGlobeDiag,
  parseDeviceEvents,
  parseReport,
  renderSummary,
  text,
} from "./maestro-summary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "maestro-summary-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const COCKPIT_FLOW = "Cockpit view (demo mode)";
const STAMPS = { "element-not-found": "2026-11-13_211613", "gpu-hang": "2026-11-13_204122" };

/** The fixture as a Maestro output dir: artifacts/<timestamp>/<flow>/{commands.json,logs/maestro.log}. */
function fixture(name) {
  const dir = path.join(scratch, "fixtures", name);
  if (existsSync(dir)) return dir;
  const src = path.join(here, "fixtures", name);
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("cockpit-flow") });
  const flowSrc = path.join(src, "cockpit-flow");
  if (existsSync(flowSrc)) {
    const flowDir = path.join(dir, "artifacts", STAMPS[name], COCKPIT_FLOW);
    mkdirSync(path.join(flowDir, "logs"), { recursive: true });
    cpSync(path.join(flowSrc, "commands.json"), path.join(flowDir, "commands.json"));
    cpSync(path.join(flowSrc, "maestro-log.txt"), path.join(flowDir, "logs", "maestro.log"));
  }
  return dir;
}

function tempDir(files) {
  const dir = mkdtempSync(path.join(scratch, "out-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const runMeta = {
  sha: "bc3371f0123456789abcdef0123456789abcdef0",
  runUrl: "https://github.com/hwinther/skylens/actions/runs/123456",
  artifact: "maestro-output-1",
};

describe("all flows passed", () => {
  const md = renderSummary(fixture("passed"), { outcome: "success", ...runMeta });

  test("one result line, the run's links and the table, nothing else", () => {
    assert.match(md, /^### ✅ Android E2E \(Maestro\): 2 flows passed in 5m 31s\n/);
    assert.match(md, /Commit `bc3371f` · \[workflow run\]\(https:\/\/github\.com\/hwinther\/skylens\/actions\/runs\/123456\) · artifact `maestro-output-1`/);
    assert.match(md, /\| Cockpit view \\\(demo mode\\\) \| `\.maestro\/cockpit\.yaml` \| ✅ passed \| 3m 28s \|/);
    assert.match(md, /\| Smoke \\\(demo mode\\\) \| `\.maestro\/smoke\.yaml` \| ✅ passed \| 2m 03s \|/);
    assert.doesNotMatch(md, /####|Device|globe|Missing/);
  });

  test("an invalid run URL or SHA is left out rather than rendered", () => {
    const bad = renderSummary(fixture("passed"), { sha: "not a sha", runUrl: "https://evil.example/x", artifact: "a b" });
    assert.doesNotMatch(bad, /evil|not a sha|Commit|artifact/);
  });
});

describe("element not found (no crash)", () => {
  const md = renderSummary(fixture("element-not-found"), { outcome: "failure", ...runMeta });

  test("result line and table", () => {
    assert.match(md, /^### ❌ Android E2E \(Maestro\): 1 of 2 flows failed \(5m 31s\)\n/);
    assert.match(md, /\| Cockpit view \\\(demo mode\\\) \| `\.maestro\/cockpit\.yaml` \| ❌ failed \| 3m 28s \|/);
  });

  test("failure message, failing step with timing, and the steps before it", () => {
    assert.match(md, /- \*\*Failure:\*\* `Element not found: Id matching regex: sim-filter`/);
    assert.match(md, /- \*\*Failing step:\*\* step 45, `Tap on id: sim-filter`, started 21:18:59, failed after 40\.0 s/);
    assert.match(md, /- 40: `Assert that id: detail-card is visible` \(0\.2 s\)\n {2}- 41: `Assert that id: sim-camera-toggle is visible` \(0\.2 s\)\n {2}- 42: `Run subflows\/dismiss-system-anr\.yaml` \(14\.9 s\)/);
  });

  test("no device findings (only boot-time noise in logcat), but the globe diagnostics", () => {
    assert.doesNotMatch(md, /#### Device/);
    assert.match(md, /- `3D globe ready, imagery failed`/);
    assert.match(md, /- `gl=webgl2 Android Emulator OpenGL ES Translator \(Google SwiftShader\)\|tex=4096\|.*\|px=0,0,0\|/);
    assert.doesNotMatch(md, /copiedText/);
  });
});

describe("GPU hang: system and app ANR, app died", () => {
  const md = renderSummary(fixture("gpu-hang"), { outcome: "failure" });

  test("device findings, in order, without the boot-time crash before the flows started", () => {
    const device = md.slice(md.indexOf("#### Device"));
    assert.match(device, /- ANR in system process `com\.android\.systemui` at 20:45:01: `App requested: Buffer processing hung up due to stuck fence\. Indicates GPU hang`/);
    assert.match(device, /- ANR in the app \(`no\.wsh\.skylens`\) at 20:45:20: `App requested/);
    assert.match(device, /- The app process `no\.wsh\.skylens` died at 20:45:22/);
    assert.match(device, /\*\*Note:\*\* the emulator's GPU hung/);
    assert.doesNotMatch(md, /googlequicksearchbox|sandboxed_process|com\.android\.systemui` died/);
  });

  test("still names the failing step", () => {
    assert.match(md, /step 45, `Tap on id: sim-filter`, started 20:45:28, failed after 17\.2 s/);
    assert.match(md, /- 44: `Tap on id: sim-camera-toggle` \(1m 04s\)/);
  });

  test("a system ANR without a GPU hang gets the generic emulator note", () => {
    const events = parseDeviceEvents(
      "11-13 20:45:01.196   533  6763 I am_anr  : [0,868,com.google.android.apps.nexuslauncher,1,Input dispatching timed out]",
      "no.wsh.skylens",
    );
    assert.deepEqual(events, [
      { type: "anr", time: "20:45:01", process: "com.google.android.apps.nexuslauncher", app: false, reason: "Input dispatching timed out" },
    ]);
    const dir = tempDir({
      "report.xml": readFileSync(path.join(fixture("element-not-found"), "report.xml")),
      "logcat.txt": "11-13 21:17:00.000   533  6763 I am_anr  : [0,868,com.google.android.apps.nexuslauncher,1,Input dispatching timed out]\n",
    });
    assert.match(renderSummary(dir), /a system \(non-app\) process went ANR/);
  });

  test("app crashes are reported with the exception", () => {
    const [crash] = parseDeviceEvents(
      "11-13 20:45:01.000   533  1 I am_crash: [5209,0,no.wsh.skylens,1,java.lang.IllegalStateException,boom, again,Foo.kt,12,0]",
      "no.wsh.skylens",
    );
    assert.equal(crash.app, true);
    assert.equal(crash.reason, "java.lang.IllegalStateException: boom, again");
  });
});

describe("missing and partial output", () => {
  test("no output directory and the emulator step skipped: the flows did not run", () => {
    const md = renderSummary(path.join(scratch, "does-not-exist"), { outcome: "skipped", ...runMeta });
    assert.match(md, /^### ❌ Android E2E \(Maestro\): the flows did not run/);
    assert.match(md, /earlier step \(build, install\) failed/);
    assert.match(md, /\[workflow run\]/);
  });

  test("no output directory although the emulator step ran", () => {
    const md = renderSummary(path.join(scratch, "does-not-exist"), { outcome: "failure" });
    assert.match(md, /^### ❌ Android E2E \(Maestro\): no result/);
    assert.match(md, /failed before Maestro wrote anything/);
  });

  test("an empty directory names what is missing", () => {
    const md = renderSummary(tempDir({}), { outcome: "failure" });
    assert.match(md, /no result/);
    assert.match(md, /Missing from the output: report\\\.xml, logcat\\\.txt/);
  });

  test("a truncated report and unreadable commands.json do not throw", () => {
    const dir = tempDir({
      "report.xml": '<testsuites><testsuite name="x" time="1"><testcase name="Cockpit view (demo mode)" status="ERROR"><failure>boom',
      "artifacts/2026-01-01_000000/Cockpit view (demo mode)/commands.json": "{ not json",
      "maestro-exit-code": "1\n",
    });
    const md = renderSummary(dir, { outcome: "failure" });
    assert.match(md, /^### ❌/);
    assert.match(md, /Missing from the output: test cases in report\\\.xml/);
    assert.match(md, /Maestro exit code: `1`/);
  });

  test("no report.xml but a flow's commands.json: the last step it got to", () => {
    const dir = tempDir({
      "artifacts/2026-01-01_000000/Cockpit view (demo mode)/commands.json": JSON.stringify([
        { command: { tapOnElement: { selector: { idRegex: "detail-cockpit" } } }, metadata: { status: "COMPLETED", sequenceNumber: 0, depth: 0, duration: 10 } },
        { command: { assertConditionCommand: { condition: { visible: { idRegex: "sim-screen" } } } }, metadata: { status: "RUNNING", sequenceNumber: 1, depth: 0 } },
      ]),
    });
    const md = renderSummary(dir, { outcome: "failure" });
    assert.match(md, /Cockpit view \\\(demo mode\\\): last step 2 `assertCondition id: sim-screen` running/);
  });

  test("a failed flow without artifacts says so", () => {
    const dir = tempDir({ "report.xml": readFileSync(path.join(fixture("gpu-hang"), "report.xml")) });
    assert.match(renderSummary(dir), /No per-flow artifacts \(commands\.json, maestro\.log\) for this flow\./);
  });

  test("an exit code with an all-passed report is still a failure", () => {
    const dir = tempDir({ "report.xml": readFileSync(path.join(fixture("passed"), "report.xml")), "maestro-exit-code": "1" });
    assert.match(renderSummary(dir), /^### ❌ Android E2E \(Maestro\): the run failed although every flow in report\.xml passed/);
  });

  test("the CLI writes the file and exits 0 even for a missing directory", () => {
    const out = path.join(scratch, "cli.md");
    execFileSync(process.execPath, [path.join(here, "maestro-summary.mjs"), path.join(scratch, "nope"), "--output", out], {
      env: { ...process.env, MAESTRO_STEP_OUTCOME: "skipped" },
    });
    assert.match(readFileSync(out, "utf8"), /the flows did not run/);
  });
});

describe("escaping untrusted log text", () => {
  const evil =
    "<img src=x onerror=alert(1)> @hwinther see https://evil.example/x and [click](http://evil.example) `rm -rf` #1 | www.evil.example \u202eevil\u0007";

  test("code() keeps it inside one code span", () => {
    const s = code(evil, 1000, { inTable: true });
    assert.equal(s.split("`").length, 3, "exactly one code span");
    assert.doesNotMatch(s, /[\u202e\u0007\n]/);
    assert.match(s, /\\\|/, "pipes escaped for tables");
  });

  test("text() breaks markup, links, mentions and references", () => {
    const s = text(evil, 1000);
    // Markdown punctuation only appears backslash-escaped ...
    assert.doesNotMatch(s, /(^|[^\\])[<>[\]()`|#]/);
    // ... and what GitHub links in the rendered text is broken up.
    assert.doesNotMatch(s, /@hwinther|#1|:\\?\/|www\\?\./);
    assert.match(s, /https\\:.\\\/\\\/evil/);
    assert.match(s, /@\u200bhwinther/);
  });

  test("lengths are capped", () => {
    assert.ok(code("x".repeat(5000), 300).length <= 302);
    assert.ok(text("x".repeat(5000), 120).length <= 120);
  });

  test("a hostile report and logs cannot inject markup into the summary", () => {
    const name = `Flow ${evil}`;
    const dir = tempDir({
      "report.xml": `<testsuites><testsuite time="3"><testcase name="${name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}" file="x.yaml" time="3" status="ERROR"><failure>${evil.replace(/&/g, "&amp;").replace(/</g, "&lt;")}&#10;## heading</failure></testcase></testsuite></testsuites>`,
      "logcat.txt": `11-13 20:45:01.196   533  6763 I am_anr  : [0,868,no.wsh.skylens,1,${evil}]\n`,
      "sim-diag.txt": `JsConsole: SkylensSim diag = gl=${evil}\n`,
    });
    const md = renderSummary(dir, { outcome: "failure" });
    // Outside code spans nothing of it survives as markup.
    const outsideCode = md.replace(/`[^`\n]*`/g, "");
    assert.doesNotMatch(outsideCode, /<img|\]\(http|https:\/\/evil|@hwinther|\n## heading/);
    assert.doesNotMatch(md, /[\u202e\u0007]/);
    // Every line of the summary is a line we wrote: no injected newlines.
    assert.ok(md.split("\n").every((l) => l === "" || /^(###|####|\||- | {2}- |Missing|Maestro|Flows|…)/.test(l)), md);
  });
});

describe("parsers", () => {
  test("parseReport reads statuses, times and failure messages", () => {
    const r = parseReport(readFileSync(path.join(fixture("element-not-found"), "report.xml"), "utf8"));
    assert.equal(r.suite.timestamp, "2026-11-13T21:16:23");
    assert.deepEqual(
      r.flows.map((f) => [f.name, f.result, f.message]),
      [
        ["Cockpit view (demo mode)", "failed", "Element not found: Id matching regex: sim-filter"],
        ["Smoke (demo mode)", "passed", ""],
      ],
    );
    assert.equal(parseReport("garbage"), null);
  });

  test("analyseFlow picks the deepest failed step and the top-level step it ran in", () => {
    const step = (kind, status, depth, seq) => ({ command: { [kind]: {} }, metadata: { status, depth, sequenceNumber: seq, duration: 1000 } });
    const a = analyseFlow(
      [step("tapOnElement", "COMPLETED", 0, 0), step("retryCommand", "FAILED", 0, 1), step("assertConditionCommand", "FAILED", 1, 2)],
      "10:00:00.000 [ INFO] maestro.cli.runner.CliConsoleListener.onCommandStart: Tap on id: a RUNNING\n" +
        "10:00:01.000 [ INFO] maestro.cli.runner.CliConsoleListener.onCommandStart: Retry 3 times RUNNING\n" +
        "10:00:02.000 [ INFO] maestro.cli.runner.CliConsoleListener.onCommandStart: Assert that id: b is visible RUNNING\n",
    );
    assert.equal(a.failing.description, "Assert that id: b is visible");
    assert.equal(a.failing.started, "10:00:02");
    assert.equal(a.parent.description, "Retry 3 times");
    assert.deepEqual(a.before.map((s) => s.description), ["Tap on id: a"]);
  });

  test("lastGlobeDiag prefers the flow's lines and skips the command echo", () => {
    const d = lastGlobeDiag(
      [
        "x CliConsoleListener.onCommandStart: Run ${console.log('SkylensSim diag = ' + maestro.copiedText)} RUNNING",
        'I/chromium( 1): [INFO:CONSOLE(147)] "SkylensSim gl=device|px=1,2,3", source: file:///x',
      ].join("\n"),
    );
    assert.deepEqual(d, { globe: "", diag: "gl=device|px=1,2,3" });
  });
});
