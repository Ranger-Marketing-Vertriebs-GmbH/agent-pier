// Smoke matrix: the REAL installed CLIs run one tool-call round trip against scripted
// loopback upstreams: Claude Code and Codex through the terminal launcher and the protocol
// adapter, OpenCode directly on its SDK routes. Rows skip with the CLI's name when it is
// missing; AGENTPIER_SKIP_CLI_SMOKE=1 skips the whole matrix (the full run takes about
// 10 s on macOS with all three CLIs installed). Every CLI runs with a temporary HOME
// and config directories, a minimal environment, a placeholder key and a dead proxy, so
// no request leaves the machine and no real profile or session is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";
import {
  smokeUpstream,
  SMOKE_ANSWER,
  SMOKE_FILE_CONTENT,
} from "../helpers/smoke-upstreams.js";

const KEY = "smoke-placeholder-key";
const DEAD_PROXY = "http://127.0.0.1:9";
const RUN_MS = 100_000;
const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);
const enabled = process.env.AGENTPIER_SKIP_CLI_SMOKE !== "1";

/** Absolute path of `command` on PATH (or itself when absolute), or null. */
function resolve(command) {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}
function version(command) {
  const file = command && resolve(command);
  if (!file) return null;
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}
const opencodeCandidates = [
  process.env.AGENTPIER_OPENCODE,
  "opencode",
  path.join(os.homedir(), ".opencode/bin/opencode"),
].filter(Boolean);
const CLIS = enabled
  ? {
      claude: { bin: resolve("claude"), version: version("claude") },
      codex: { bin: resolve("codex"), version: version("codex") },
      opencode: (() => {
        const bin = opencodeCandidates.find((c) => version(c));
        return { bin: bin ? resolve(bin) : null, version: bin ? version(bin) : null };
      })(),
    }
  : {};
const skipFor = (tool) =>
  !enabled
    ? "AGENTPIER_SKIP_CLI_SMOKE=1 skips the real-CLI smoke matrix"
    : CLIS[tool].version
      ? false
      : `${tool} CLI is not installed`;

// account(tool): the managed endpoint account the launch is prepared for
const account = (tool) => ({
  kind: "managed",
  tool,
  provider: { id: "endpoint", modelId: "qwen3" },
});

/** Enables only `source`; adapter routes are explicit because ADAPTER_AUTO_ROUTES = false. */
const endpointFor = (up, tool, source) =>
  validateEndpoint({
    preset: "custom",
    openaiBaseUrl: `${up.base}/v1`,
    anthropicBaseUrl: up.base,
    protocols: {
      messages: false,
      responses: false,
      chatCompletions: false,
      [source]: true,
    },
    authHeader: null,
    routing: { [tool]: tool === "opencode" ? source : `adapter:${source}` },
    models: [
      {
        modelId: "qwen3",
        label: "Qwen smoke",
        contextTokens: 65536,
        outputTokens: 8192,
        source: "manual",
        contextEdited: true,
      },
    ],
    lastTest: null,
  });

/** Temp root (HOME and provider dirs) and a separate cwd holding smoke.txt. */
function workspace(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-smoke-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(root, "tmp"));
  fs.writeFileSync(path.join(cwd, "smoke.txt"), `${SMOKE_FILE_CONTENT}\n`);
  return { root, cwd };
}

/** Minimal (`env -i`-style) CLI environment: nothing of the user's session is inherited. */
const baseEnv = (root) => ({
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: path.join(root, "tmp"),
  LANG: "en_US.UTF-8",
  HTTPS_PROXY: DEAD_PROXY,
  HTTP_PROXY: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  // Claude Code: no updater or telemetry traffic.
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // OpenCode: no models.dev fetch, update check or LSP download.
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
});

function prepare(tool, up, source, { root }, args) {
  return prepareProviderLaunch(
    account(tool),
    { apiKey: KEY },
    { command: CLIS[tool].bin, args, env: baseEnv(root) },
    {
      root,
      catalog: new ProviderCatalog(),
      endpoint: endpointFor(up, tool, source),
      connectionName: "Smoke",
    },
  );
}

function collect(child) {
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGTERM"), RUN_MS);
  return new Promise((done) =>
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    }),
  );
}

/**
 * Writes the private launch payload (CLI command, argv, env and the adapter block with a
 * diagnostics path) and runs the real terminal launcher on it. The launcher's supervisor
 * binds the loopback port, starts the adapter and substitutes the URL placeholders.
 */
async function runThroughLauncher(t, launch, cwd, extraArgs = []) {
  assert.ok(launch.adapter, "the launch is prepared with an adapter route");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-smoke-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "smoke.launch.json");
  const diagnosticsPath = path.join(dir, "smoke.adapter.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      command: launch.command,
      args: [...launch.args, ...extraArgs],
      cwd,
      env: launch.env,
      // No session record: an unguarded generation, a random prompt-cache key.
      adapter: { ...launch.adapter, diagnosticsPath, generation: null, sessionKey: null },
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [launcher, file], {
    cwd,
    env: { PATH: process.env.PATH, HOME: launch.env.HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await collect(child);
  assert.equal(fs.existsSync(file), false, "the payload is one-use");
  const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
  for (const kind of ["stream.invalid", "request.invalid"])
    assert.equal(diagnostics.errors?.[kind], undefined, `${kind} in adapter diagnostics`);
  assert.equal(JSON.stringify(diagnostics).includes(KEY), false, "key in diagnostics");
  return { ...result, diagnostics };
}

/** Runs an SDK-route CLI directly with the prepared env (no adapter on SDK routes). */
async function runDirect(launch, cwd, extraArgs) {
  assert.equal(launch.adapter, undefined, "SDK routes need no adapter");
  const child = spawn(launch.command, [...launch.args, ...extraArgs], {
    cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ...(await collect(child)), diagnostics: null };
}

/** Common assertions of one row; records the CLI version, timing and carrier replay. */
function verify(t, tool, source, up, result, started) {
  const detail = `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  t.diagnostic(
    `${tool} ${CLIS[tool].version}: ${Date.now() - started} ms, ` +
      `${up.seen.length} upstream requests, ${up.turns()} turns, carrier replayed: ${up.carrier()}`,
  );
  if (result.diagnostics)
    t.diagnostic(`adapter diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.deepEqual(up.problems, [], detail);
  assert.match(result.stdout, new RegExp(SMOKE_ANSWER), detail);
  assert.equal(result.code, 0, detail);
  assert.equal(
    up.turns(),
    2,
    "tool call and tool result; tool-less side requests excluded",
  );
  assert.equal(
    up.seen.every((e) => e.headers.authorization === `Bearer ${KEY}`),
    true,
    "every upstream request carries the upstream key as Bearer",
  );
  for (const entry of up.seen)
    assert.equal(entry.headers["x-api-key"], undefined, "no x-api-key upstream");
  // Chat has no carrier to replay unless reasoningReplay is enabled (off by default).
  if (source !== "chatCompletions")
    assert.equal(up.carrier(), true, "turn 2 replays the reasoning carrier of turn 1");
}

for (const source of ["responses", "chatCompletions"])
  test(
    `Claude Code round-trips a tool call through the adapter from ${source}`,
    { skip: skipFor("claude"), timeout: 120_000 },
    async (t) => {
      const ws = workspace(t);
      const up = await smokeUpstream(t, source, {
        toolName: "Read",
        toolInput: { file_path: path.join(ws.cwd, "smoke.txt") },
      });
      const started = Date.now();
      const launch = prepare("claude", up, source, ws, [
        "-p",
        "Read smoke.txt and answer.",
      ]);
      const result = await runThroughLauncher(t, launch, ws.cwd);
      verify(t, "claude", source, up, result, started);
    },
  );

const codexRows = [
  ["messages", "exec_command", { cmd: "cat smoke.txt" }, SMOKE_FILE_CONTENT],
  ["chatCompletions", "exec_command", { cmd: "cat smoke.txt" }, SMOKE_FILE_CONTENT],
  // Fact R6: a call without argument text must reach Codex as "{}", or Codex answers the
  // call itself with a parse error instead of running the tool.
  ["chatCompletions", "get_goal", {}, null],
];
for (const [source, toolName, toolInput, expectResult] of codexRows)
  test(
    `Codex round-trips a ${toolName} call through the adapter from ${source}`,
    { skip: skipFor("codex"), timeout: 120_000 },
    async (t) => {
      const ws = workspace(t);
      const up = await smokeUpstream(t, source, { toolName, toolInput, expectResult });
      const started = Date.now();
      const launch = prepare("codex", up, source, ws, ["exec", "--skip-git-repo-check"]);
      const prompt =
        toolName === "get_goal"
          ? "Check the current goal and answer."
          : "Run cat smoke.txt and answer.";
      const result = await runThroughLauncher(t, launch, ws.cwd, [prompt]);
      verify(t, "codex", source, up, result, started);
      t.diagnostic(`tool result: ${up.results.join(" | ").slice(0, 300)}`);
      if (!Object.keys(toolInput).length)
        assert.deepEqual(
          Object.keys(up.schema()?.properties ?? {}),
          [],
          `${toolName} must take no parameters: ${JSON.stringify(up.schema())}`,
        );
      for (const text of up.results)
        assert.equal(
          /failed to parse function arguments/i.test(text),
          false,
          `Codex rejected the call arguments: ${text}`,
        );
    },
  );

for (const source of ["messages", "responses"])
  test(
    `OpenCode round-trips a tool call on the ${source} SDK route`,
    { skip: skipFor("opencode"), timeout: 120_000 },
    async (t) => {
      const ws = workspace(t);
      const up = await smokeUpstream(t, source, {
        toolName: "read",
        toolInput: { filePath: path.join(ws.cwd, "smoke.txt") },
      });
      const started = Date.now();
      const launch = prepare("opencode", up, source, ws, ["run"]);
      assert.deepEqual(launch.provider.route, { mode: "sdk", source });
      const result = await runDirect(launch, ws.cwd, ["Read smoke.txt and answer."]);
      verify(t, "opencode", source, up, result, started);
    },
  );
