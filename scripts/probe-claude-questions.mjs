import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { applicationFixture } from "../tests/helpers/application.js";
import { prepareClaude } from "./probe-claude-startup.mjs";
import { createQuestionProvider } from "./probe-claude-questions-provider.mjs";
import { shellQuote } from "../server/lib/launch-serialization.js";

const execute = promisify(execFile);
const cleanup = [];
const options = process.argv.slice(2);
assert.ok(
  options.includes("--local-mock"),
  "Pass --local-mock for the isolated provider",
);
async function waitFor(read, predicate, timeout = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const result = await read();
    if (predicate(result)) return result;
    await sleep(50);
  }
  throw Error("Native question observation timed out");
}

try {
  const fixture = await applicationFixture({ after: (fn) => cleanup.push(fn) });
  const provider = await createQuestionProvider();
  cleanup.push(() => provider.close());
  const manager = fixture.application.sessions;
  const binary = (await execute("/usr/bin/which", ["claude"])).stdout.trim();
  const env = {
    HOME: fixture.home,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    COLORTERM: "truecolor",
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
  };
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ])
    await fs.mkdir(env[name]);
  await fs.writeFile(
    path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
    }),
  );
  const project = path.join(fixture.home, "project");
  await fs.mkdir(project);
  const version = (
    await execute(binary, ["--version"], { env, cwd: project })
  ).stdout.trim();
  if (os.platform() === "darwin") {
    const probeBin = path.join(fixture.root, "probe-bin");
    await fs.mkdir(probeBin);
    const probePs = path.join(probeBin, "ps");
    await fs.copyFile("/bin/ps", probePs);
    await fs.chmod(probePs, 0o755);
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", probePs]);
    env.PATH = `${probeBin}${path.delimiter}${env.PATH}`;
  }
  const id = randomUUID();
  const account = fixture.application.accounts.create({
    name: "Question probe",
    tool: "claude",
  });
  let launch = await fixture.application.bindings.prepare({
    id,
    account,
    cwd: project,
    launch: {
      command: binary,
      args: [
        "--model",
        "claude-sonnet-4-6",
        "--debug-file",
        path.join(fixture.root, "claude-debug.log"),
      ],
      env,
    },
  });
  launch = await fixture.application.requests.prepare({
    id,
    account,
    cwd: project,
    launch,
  });
  const legacyHook = options.includes("--legacy-hook")
    ? options[options.indexOf("--legacy-hook") + 1]
    : null;
  if (legacyHook) {
    assert.ok(path.isAbsolute(legacyHook));
    await fs.access(legacyHook);
    const hookFile = path.join(
      fixture.application.requests.directory,
      `${id}.claude/hooks/hooks.json`,
    );
    const hooks = JSON.parse(await fs.readFile(hookFile, "utf8"));
    for (const groups of Object.values(hooks.hooks))
      for (const group of groups)
        for (const hook of group.hooks)
          hook.command = [process.execPath, legacyHook].map(shellQuote).join(" ");
    await fs.writeFile(hookFile, JSON.stringify(hooks));
    const file = launch.env.AGENTPIER_REQUEST_FILE;
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    delete config.claudeHookVersion;
    await fs.writeFile(file, JSON.stringify(config));
  }
  const isolatedArgs = [
    "-i",
    ...Object.entries(launch.env).map(([key, value]) => `${key}=${value}`),
    launch.command,
    ...launch.args,
  ];
  const sandbox = `(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))(deny file-read* (subpath ${JSON.stringify(path.join(os.homedir(), "Library/Keychains"))}) (subpath ${JSON.stringify(path.join(os.homedir(), ".claude"))}) (literal ${JSON.stringify(path.join(os.homedir(), ".claude.json"))}))`;
  const session = await manager.create({
    id,
    accountId: account.id,
    tool: "claude",
    name: "Question probe",
    cwd: project,
    command: os.platform() === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/env",
    args:
      os.platform() === "darwin"
        ? ["-p", sandbox, "/usr/bin/env", ...isolatedArgs]
        : isolatedArgs,
    env: {},
    nativeRequests: launch.nativeRequests,
    nativeBinding: launch.nativeBinding,
  });
  const target = `${manager.target(id)}:0.0`;
  const capture = () => manager.tmux(["capture-pane", "-p", "-t", target]);
  const keys = (...names) => manager.tmux(["send-keys", "-t", target, ...names]);
  try {
    await prepareClaude({ fixture, session, capture, keys, options: [], waitFor });
    await waitFor(() => fixture.application.bindings.verifiedReceipt(session), Boolean);
    for (let i = 0; i < 2; i++) {
      if (i === 1 && legacyHook) {
        await fixture.restart();
        const state = await fixture.application.requests.list(id);
        assert.equal(state.integration?.reloadRequired, true);
        await manager.tmux(["send-keys", "-l", "-t", target, "--", "/reload-plugins"]);
        await keys("Enter");
        await waitFor(capture, (screen) => /[Rr]eloaded/.test(screen));
        await sleep(500);
      }
      const response = await fixture.request(`/api/sessions/${id}/input`, {
        method: "POST",
        body: {
          deliveryId: randomUUID(),
          deliveryScope: JSON.stringify([
            id,
            account.id,
            "claude",
            session.createdAt || null,
          ]),
          text: `AP_QUESTION_PROBE_${i}`,
          submit: true,
        },
      });
      assert.equal((await response.json()).status, "handed-off");
      const pending = await waitFor(
        async () =>
          (await (await fixture.request(`/api/sessions/${id}/requests`)).json()).requests,
        (requests) => requests.some((request) => request.kind === "question"),
      );
      const request = pending.find((request) => request.kind === "question");
      assert.equal(request.questions.length, 2);
      if (options.includes("--terminal")) {
        const { answerQuestionInBrowser } =
          await import("./probe-claude-question-browser.mjs");
        await answerQuestionInBrowser(fixture, session, {
          terminalCheck: async (page) => {
            const screen = await waitFor(capture, (text) =>
              text.replace(/\s+/g, " ").includes("Which components should be included?"),
            );
            assert.match(screen, /API/);
            assert.match(screen, /Web/);
            assert.deepEqual((await fixture.application.requests.list(id)).requests, []);
            assert.equal(provider.results.length, 0, "Handoff must not select an answer");
            await fs.mkdir(".cache", { recursive: true });
            await page.screenshot({ path: ".cache/claude-native-terminal-question.png" });
          },
        });
        console.log(
          JSON.stringify(
            {
              mode: "native-terminal-local-mock",
              version,
              nativeQuestionVisible: true,
              automaticAnswer: false,
              screenshot: ".cache/claude-native-terminal-question.png",
            },
            null,
            2,
          ),
        );
        break;
      }
      if (i === 1) {
        await fixture.restart();
        const recovered = await waitFor(
          () => fixture.application.requests.list(id),
          (state) => state.requests.some((entry) => entry.id === request.id),
        );
        assert.equal(recovered.requests.length, 1);
        assert.equal(recovered.integration, undefined);
      }
      if (i === 1 && options.includes("--browser")) {
        const { answerQuestionInBrowser } =
          await import("./probe-claude-question-browser.mjs");
        await answerQuestionInBrowser(fixture, session);
      } else {
        const reply = await fixture.request(
          `/api/sessions/${id}/requests/${request.id}/answer`,
          {
            method: "POST",
            body: {
              expectedRevision: request.revision,
              answers: { q0: ["API", "Web"], q1: ["Custom destination ü\nsecond line"] },
            },
          },
        );
        assert.equal(reply.status, 200, JSON.stringify(await reply.json()));
      }
      await waitFor(
        () => provider.results,
        (results) => results.length === i + 1,
      );
      const received = JSON.stringify(provider.results[i]);
      assert.match(received, /API, Web/);
      assert.match(received, /Custom destination ü/);
      assert.match(received, /second line/);
      assert.ok(!provider.results[i].is_error, received);
      await waitFor(capture, (screen) => screen.includes("Question probe complete."));
      await sleep(300);
    }
    if (!options.includes("--terminal"))
      console.log(
        JSON.stringify(
          {
            mode: "native-local-mock",
            version,
            platform: `${os.platform()} ${os.arch()}`,
            repeatedQuestions: 2,
            multiple: true,
            multilineOther: true,
            nativeToolResults: provider.results.length,
            pendingQuestionSurvivedRestart: true,
            legacyPluginMigrated: !!legacyHook,
            realBrowserAnswer: options.includes("--browser"),
          },
          null,
          2,
        ),
      );
  } catch (error) {
    console.error((await capture()).replaceAll(fixture.root, "<fixture>"));
    const debug = await fs
      .readFile(path.join(fixture.root, "claude-debug.log"), "utf8")
      .catch(() => "");
    console.error(
      debug
        .split("\n")
        .filter((line) => /hook|plugin|error/i.test(line))
        .slice(-45)
        .join("\n")
        .replaceAll(fixture.root, "<fixture>"),
    );
    throw error;
  }
} finally {
  for (const dispose of cleanup.reverse()) await dispose();
}
