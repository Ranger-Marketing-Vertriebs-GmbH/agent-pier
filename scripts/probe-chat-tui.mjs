import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { applicationFixture } from "../tests/helpers/application.js";
import { createTuiInputRecorder } from "../tests/helpers/tui-input-recorder.js";
import { probeNativePayloads } from "./probe-chat-tui-payloads.mjs";
import { probeNativeRecovery } from "./probe-chat-tui-recovery.mjs";
import { createProbeProvider } from "./probe-chat-tui-provider.mjs";
import { probeTerminalKeyboard } from "./probe-terminal-keyboard.mjs";

const execute = promisify(execFile);
const options = process.argv.slice(2);
const native = options.includes("--native");
const httpMode = options.includes("--http");
const bound = options.includes("--bound");
const bootstrap = options.includes("--bootstrap");
const samples = options.includes("--samples")
  ? Number(options[options.indexOf("--samples") + 1])
  : 30;
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 30);
const tool = options[options.indexOf("--tool") + 1];
if (!options.includes("--synthetic") && !native) {
  throw new Error(
    "Use --synthetic or --native --tool codex|claude|opencode --local-mock",
  );
}
if (
  native &&
  (!options.includes("--local-mock") || !["codex", "claude", "opencode"].includes(tool))
) {
  console.log(
    JSON.stringify({
      status: "not-executable",
      reason:
        "Native probes require --tool and explicit --local-mock test provider configuration.",
    }),
  );
  process.exitCode = 2;
} else {
  const cleanup = [];
  try {
    const fixture = await applicationFixture({ after: (fn) => cleanup.push(fn) });
    if (native) await probeNative(fixture);
    else await probeSynthetic(fixture);
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
}

async function waitFor(read, predicate, timeout = 15000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(20);
  }
  throw new Error("Probe observation timed out; no submit is retried");
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

async function paste(manager, session, text) {
  const buffer = `probe-${randomUUID()}`;
  const target = `${manager.target(session.id)}:0.0`;
  await manager.tmux(["load-buffer", "-b", buffer, "-"], { input: text });
  try {
    await manager.tmux(["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", target]);
    await manager.tmux(["send-keys", "-t", target, "Enter"]);
  } finally {
    await manager.tmux(["delete-buffer", "-b", buffer]).catch(() => {});
  }
}

async function probeSynthetic(fixture) {
  const manager = fixture.application.sessions;
  const report = [];
  for (const name of ["codex", "claude", "opencode"]) {
    const recorder = await createTuiInputRecorder(fixture);
    const account = fixture.application.accounts.create({
      name: "Synthetic probe",
      tool: name,
    });
    const session = await manager.create({
      id: `probe-${name}`,
      name: "Synthetic probe",
      tool: name,
      accountId: account.id,
      cwd: fixture.home,
      command: recorder.command,
      args: recorder.args,
      env: { HOME: fixture.home },
    });
    await recorder.waitForText("ready");
    const timings = [];
    for (let n = 0; n < samples; n++) {
      const marker = `AP_PROBE_${name.toUpperCase()}_${n}`;
      const before = (await recorder.readBytes()).length;
      const start = performance.now();
      await paste(manager, session, marker);
      timings.push(performance.now() - start);
      await recorder.waitForText(`\x1b[200~${marker}\x1b[201~\r`);
      assert.equal(
        (await recorder.readBytes()).subarray(before).toString(),
        `\x1b[200~${marker}\x1b[201~\r`,
      );
    }
    report.push({
      tool: name,
      route: "direct-tmux",
      submitMs: summary(timings),
      stdinChunks: (await recorder.receivedAt()).length,
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: "synthetic",
        platform: `${os.platform()} ${os.arch()}`,
        report,
        limitation:
          "Raw byte transport only; these are not HTTP timings or native CLI acceptance measurements.",
      },
      null,
      2,
    ),
  );
}

async function probeNative(fixture) {
  const provider = await createProbeProvider();
  try {
    const manager = fixture.application.sessions;
    const binary = (await execute("/usr/bin/which", [tool])).stdout.trim();
    const env = {
      HOME: fixture.home,
      PATH: process.env.PATH,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      COLORTERM: "truecolor",
      CODEX_HOME: path.join(fixture.home, "codex"),
      CLAUDE_CONFIG_DIR: path.join(fixture.home, "claude"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(fixture.home, "claude"),
      XDG_CONFIG_HOME: path.join(fixture.home, "config"),
      XDG_DATA_HOME: path.join(fixture.home, "data"),
      XDG_CACHE_HOME: path.join(fixture.home, "cache"),
      ANTHROPIC_API_KEY: "synthetic-probe-key",
      ANTHROPIC_BASE_URL: provider.url,
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          anthropic: {
            options: { baseURL: `${provider.url}/v1`, apiKey: "synthetic-probe-key" },
          },
        },
      }),
    };
    for (const key of [
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
    ])
      await fs.mkdir(env[key]);
    await fs.writeFile(
      path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, theme: "dark" }),
    );
    const project = path.join(fixture.home, "project");
    await fs.mkdir(project);
    const version = (
      await execute(binary, ["--version"], { env, cwd: project })
    ).stdout.trim();
    const args =
      tool === "codex"
        ? [
            "--no-alt-screen",
            "-c",
            'model_provider="probe"',
            "-c",
            `model_providers.probe={name="probe",base_url="${provider.url}/v1",wire_api="responses",requires_openai_auth=false}`,
            "-m",
            "probe",
          ]
        : tool === "claude"
          ? [...(bound ? [] : ["--bare"]), "--model", "claude-sonnet-4-6"]
          : ["--model", "anthropic/claude-sonnet-4-6"];
    const account = fixture.application.accounts.create({
      name: "Disposable native probe",
      tool,
    });
    if (bound && tool === "claude" && os.platform() === "darwin") {
      // The platform ps binary cannot execute under Seatbelt. A disposable,
      // unprivileged signed copy performs the same real process inspection.
      const probeBin = path.join(fixture.root, "probe-bin");
      await fs.mkdir(probeBin);
      const probePs = path.join(probeBin, "ps");
      await fs.copyFile("/bin/ps", probePs);
      await fs.chmod(probePs, 0o755);
      await execute("/usr/bin/codesign", ["--force", "--sign", "-", probePs]);
      env.PATH = `${probeBin}${path.delimiter}${env.PATH}`;
    }
    const sessionId = bound ? randomUUID() : `native-${tool}`;
    if (bound && tool === "codex") args.push("--dangerously-bypass-hook-trust");
    if (bound && tool === "claude")
      args.push("--debug-file", path.join(fixture.root, "claude-debug.log"));
    const launch = bound
      ? await fixture.application.bindings.prepare({
          id: sessionId,
          account,
          cwd: project,
          launch: { command: binary, args, env },
        })
      : { command: binary, args, env };
    const isolatedArgs = [
      "-i",
      ...Object.entries(launch.env).map(([key, value]) => `${key}=${value}`),
      launch.command,
      ...launch.args,
    ];
    const useKeychainSandbox = bound && tool === "claude" && os.platform() === "darwin";
    const sandbox = `(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))(deny file-read* (subpath ${JSON.stringify(path.join(os.homedir(), "Library/Keychains"))}) (subpath ${JSON.stringify(path.join(os.homedir(), ".claude"))}) (literal ${JSON.stringify(path.join(os.homedir(), ".claude.json"))}))`;
    const session = await manager.create({
      id: sessionId,
      name: "Native probe",
      tool,
      accountId: account.id,
      cwd: project,
      command: useKeychainSandbox ? "/usr/bin/sandbox-exec" : "/usr/bin/env",
      args: useKeychainSandbox
        ? ["-p", sandbox, "/usr/bin/env", ...isolatedArgs]
        : isolatedArgs,
      env: {},
      nativeBinding: launch.nativeBinding,
    });
    const target = `${manager.target(session.id)}:0.0`;
    const capture = () => manager.tmux(["capture-pane", "-p", "-t", target]);
    const snapshot = async () => {
      const raw = await manager.tmux(["capture-pane", "-e", "-p", "-t", target]);
      const values = (
        await manager.tmux([
          "display-message",
          "-p",
          "-t",
          target,
          "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}",
        ])
      )
        .trim()
        .split(" ")
        .map(Number);
      return {
        raw: raw.replaceAll(fixture.root, "<temporary-root>"),
        pane: Object.fromEntries(
          ["cursorX", "cursorY", "width", "height"].map((key, i) => [key, values[i]]),
        ),
      };
    };
    const snapshots = {};
    const httpSubmit = [];
    const counts = { paste: 0, submit: 0 };
    let httpEntry, submitEnd;
    fixture.application.server.prependListener("request", (request) => {
      if (
        request.method === "POST" &&
        request.url === `/api/sessions/${session.id}/input`
      )
        httpEntry = performance.now();
    });
    const originalTmux = manager.tmux.bind(manager);
    manager.tmux = async (args, opts) => {
      const result = await originalTmux(args, opts);
      if (args[0] === "paste-buffer") counts.paste++;
      if (args[0] === "send-keys" && args.at(-1) === "Enter") {
        submitEnd = performance.now();
        counts.submit++;
      }
      return result;
    };
    const send = async (text) => {
      if (!httpMode) return paste(manager, session, text);
      httpEntry = submitEnd = undefined;
      const result = await fixture.request(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: {
          deliveryId: randomUUID(),
          deliveryScope: JSON.stringify([
            session.id,
            session.accountId,
            session.tool,
            session.createdAt || null,
          ]),
          text,
          submit: true,
        },
      });
      const receipt = await result.json();
      assert.equal(receipt.status, "handed-off", JSON.stringify(receipt));
      assert.ok(Number.isFinite(httpEntry) && Number.isFinite(submitEnd));
      httpSubmit.push(submitEnd - httpEntry);
    };
    const keys = (...names) => manager.tmux(["send-keys", "-t", target, ...names]);
    if (tool === "codex") {
      await waitFor(capture, (screen) => screen.includes("Yes, continue"));
      await sleep(750);
      await keys("Enter");
      await waitFor(capture, (screen) =>
        screen.includes("Ask Codex to do anything"),
      ).catch(async (error) => {
        console.error(
          (await capture())
            .replaceAll(fixture.root, "<temporary-root>")
            .replace(/[a-f0-9]{48}/g, "<fixture-token>"),
        );
        throw error;
      });
    } else if (tool === "claude") {
      const trust = await waitFor(capture, (screen) =>
        screen.includes("Yes, I trust this folder"),
      );
      await sleep(750);
      await keys(...(/❯[^\n]*Yes, I trust/.test(trust) ? ["Enter"] : ["Down", "Enter"]));
      const auth = await waitFor(
        capture,
        (screen) => screen.includes("custom API key") || screen.includes("for shortcuts"),
      );
      if (auth.includes("custom API key")) {
        await sleep(750);
        await keys("Up", "Enter");
      }
      await waitFor(capture, (screen) => screen.includes("for shortcuts"));
    } else await waitFor(capture, (screen) => screen.includes("Ask anything"));
    if (bound && bootstrap) {
      await paste(manager, session, "AP_PROBE_BOOTSTRAP");
      await waitFor(capture, (screen) =>
        screen.includes("Synthetic response complete: AP_PROBE_BOOTSTRAP"),
      );
    }
    if (bound && (tool !== "codex" || bootstrap))
      await waitFor(
        () => fixture.application.bindings.verifiedReceipt(session),
        Boolean,
      ).catch(async (error) => {
        const scrub = (value) =>
          value
            .replaceAll(fixture.root, "<temporary-root>")
            .replace(/[a-f0-9]{48}/g, "<fixture-token>");
        console.error("BOUND_STARTUP", scrub(await capture()));
        const launchFile = fixture.application.bindings.file(session.id);
        const bindingReceipt = await fs
          .readFile(launchFile.replace(/\.launch\.json$/, ".receipt.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => ({ missing: error.code }));
        const launchRecord = JSON.parse(await fs.readFile(launchFile, "utf8"));
        console.error(
          "BOUND_RECEIPT",
          JSON.stringify(
            bindingReceipt.missing
              ? bindingReceipt
              : {
                  idMatch: bindingReceipt.id === session.id,
                  accountMatch: bindingReceipt.accountId === session.accountId,
                  cwdMatch: bindingReceipt.cwd === launchRecord.cwd,
                  toolMatch: bindingReceipt.tool === tool,
                  tokenMatch: bindingReceipt.token === launchRecord.token,
                  pid: bindingReceipt.pid,
                  pidStart: bindingReceipt.pidStart,
                  updatedAt: bindingReceipt.updatedAt,
                },
          ),
        );
        if (tool === "claude") {
          const debug = await fs
            .readFile(path.join(fixture.root, "claude-debug.log"), "utf8")
            .catch(() => "");
          console.error(
            "CLAUDE_HOOK_LOG",
            scrub(
              debug
                .split("\n")
                .filter((line) => /hook|plugin|agentpier/i.test(line))
                .slice(-40)
                .join("\n"),
            ),
          );
        }
        const logDirectory = path.join(env.CODEX_HOME, "log");
        const names = await fs.readdir(logDirectory).catch(() => []);
        for (const name of names)
          if (name.endsWith(".log")) {
            const content = await fs.readFile(path.join(logDirectory, name), "utf8");
            console.error(
              "BOUND_HOOK_LOG",
              scrub(
                content
                  .split("\n")
                  .filter((line) => /hook|binding/i.test(line))
                  .slice(-15)
                  .join("\n"),
              ),
            );
          }
        throw error;
      });
    if (options.includes("--keyboard-only")) {
      const result = await probeTerminalKeyboard({
        manager,
        session,
        capture,
        provider,
        waitFor,
      });
      console.log(
        JSON.stringify({
          tool,
          version,
          platform: `${os.platform()} ${os.arch()}`,
          result,
        }),
      );
      return;
    }
    const bindingAtFirstInput = Boolean(
      fixture.application.bindings.verifiedReceipt(session),
    );
    const idle = await capture();
    snapshots.idle = await snapshot();
    if (tool === "opencode") {
      await keys("Tab");
      await waitFor(capture, (screen) => screen.includes("Plan · "));
      snapshots.plan = await snapshot();
      await keys("Tab");
      await waitFor(capture, (screen) => screen.includes("Build · "));
    }
    await send("AP_PROBE_HOLD");
    if (bound)
      await waitFor(() => fixture.application.bindings.verifiedReceipt(session), Boolean);
    await waitFor(
      () => provider.events,
      (events) =>
        events.some(
          (event) => event.kind === "request" && event.marker === "AP_PROBE_HOLD",
        ),
    );
    await sleep(1500);
    const busy = await capture();
    snapshots.busy = await snapshot();
    await send("AP_PROBE_SECOND");
    const queued = await waitFor(
      capture,
      (screen) =>
        screen.includes("AP_PROBE_SECOND") &&
        (tool === "codex"
          ? screen.includes("Messages to be submitted")
          : tool === "claude"
            ? screen.includes("queued messages")
            : screen.includes("QUEUED")),
    );
    snapshots.queued = await snapshot();
    assert.equal(
      provider.events.some(
        (event) => event.kind === "complete" && event.marker === "AP_PROBE_HOLD",
      ),
      false,
      "Second input must be queued before held response completes",
    );
    await waitFor(capture, (screen) =>
      screen.includes("Synthetic response complete: AP_PROBE_SECOND"),
    );
    const submit = [],
      echo = [];
    for (let n = 0; n < samples; n++) {
      const marker = `AP_PROBE_MEASURE_${n}`;
      const start = performance.now();
      await send(marker);
      submit.push(performance.now() - start);
      await waitFor(capture, (screen) => screen.includes(marker));
      echo.push(performance.now() - start);
      await waitFor(capture, (screen) =>
        screen.includes(`Synthetic response complete: ${marker}`),
      );
      await sleep(50);
    }
    const payloads = httpMode
      ? await probeNativePayloads({ tool, send, capture, provider, waitFor, counts })
      : undefined;
    const recovery = httpMode
      ? await probeNativeRecovery(fixture, session, snapshot, counts)
      : undefined;
    if (!httpMode)
      await manager.tmux([
        "send-keys",
        "-l",
        "-t",
        target,
        "--",
        "SYNTHETIC draft ünicode",
      ]);
    await sleep(150);
    snapshots.draft = await snapshot();
    const clean = (screen) =>
      screen
        .replaceAll(fixture.root, "<temporary-root>")
        .replaceAll(`/private${fixture.root}`, "<temporary-root>");
    console.log(
      JSON.stringify(
        {
          mode: "native-local-mock",
          recordedAt: new Date().toISOString(),
          node: process.version,
          paneSize: { width: 120, height: 35 },
          nativeBinding: bound,
          bindingAtFirstInput,
          directBootstrap: bootstrap,
          tool,
          version,
          platform: `${os.platform()} ${os.arch()} ${os.release()}`,
          route: httpMode ? "http" : "direct-tmux",
          httpEntryToSubmitMs: httpMode
            ? summary(httpSubmit.slice(2, 2 + samples))
            : undefined,
          recovery,
          payloads,
          holdMs: 8000,
          queuedBeforeCompletion: true,
          pasteSubmitDelayMs: 0,
          submitMs: summary(submit),
          visibleEchoMs: summary(echo),
          screens: { idle: clean(idle), busy: clean(busy), queued: clean(queued) },
          snapshots,
          limitations:
            "Local provider and default keybindings only. HTTP route is measured only with --http. Short-draft recovery is measured with --http. No conclusions about themes, resized or truncated composers, or tool execution.",
        },
        null,
        2,
      ),
    );
  } finally {
    await provider.close();
  }
}
