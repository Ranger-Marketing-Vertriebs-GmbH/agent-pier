import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  BrowserLaunchCheck,
  launchProblem,
  probeLaunch,
} from "../../server/features/assistants/browser-launch-check.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { browserStatus } from "../../server/features/assistants/runtime-view.js";
import { hermesApplyWiring } from "../../server/application/hermes-wiring.js";

const sandboxLine =
  "[1:1:ERROR:zygote_host_impl_linux.cc(130)] No usable sandbox! If you are running on Ubuntu 23.10+ ...";

// A spawn that answers like a Chromium start: `stdout`, `stderr`, then close, or an
// `error` as the spawn of a missing file, or nothing at all (a hung start).
function fakeSpawn({ stdout = "", stderr = "", error = null, hang = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ file, args, options, child });
    setImmediate(() => {
      if (error) return child.emit("error", Object.assign(Error(error), { code: error }));
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit("close", stdout ? 0 : 1));
    });
    return child;
  };
  return { spawn, calls };
}

test("a start is classified by its spawn error and its output", () => {
  assert.equal(launchProblem({ error: { code: "ENOENT" } }), "missing");
  assert.equal(launchProblem({ error: { code: "EACCES" } }), "missing");
  assert.equal(launchProblem({ output: sandboxLine }), "sandbox");
  assert.equal(
    launchProblem({
      output: "Failed to move to new namespace: PID namespaces supported, but failed",
    }),
    "sandbox",
  );
  assert.equal(
    launchProblem({ output: "error while loading shared libraries" }),
    "crashed",
  );
  assert.equal(launchProblem({}), "crashed");
});

test("the probe starts headless with the sandbox on and reads the page", async () => {
  const { spawn, calls } = fakeSpawn({
    stdout: "<html><head></head><body></body></html>",
  });
  assert.equal(
    await probeLaunch("/usr/bin/chromium", {
      spawn,
      platform: "linux",
      env: { PATH: "/b", HTTPS_PROXY: "http://proxy" },
    }),
    "ok",
  );
  const [{ file, args, options }] = calls;
  assert.equal(file, "/usr/bin/chromium");
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--dump-dom"));
  assert.ok(args.includes("--no-proxy-server"));
  assert.equal(args.at(-1), "about:blank");
  // The sandbox is never switched off.
  assert.ok(!args.some((arg) => /no-sandbox|zygote/.test(arg)));
  assert.equal(options.env.HTTPS_PROXY, undefined);
  assert.equal(options.env.PATH, "/b");
  // Its private profile is gone after the check.
  const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).split("=")[1];
  assert.equal(fs.existsSync(profile), false);
});

test("the probe reports a blocked sandbox, a missing app and a slow one", async () => {
  assert.equal(
    await probeLaunch("/c", { spawn: fakeSpawn({ stderr: sandboxLine }).spawn }),
    "sandbox",
  );
  assert.equal(
    await probeLaunch("/c", { spawn: fakeSpawn({ error: "ENOENT" }).spawn }),
    "missing",
  );
  assert.equal(
    await probeLaunch("/c", {
      spawn: fakeSpawn({ stderr: "Trace/breakpoint trap" }).spawn,
    }),
    "crashed",
  );
  const hung = fakeSpawn({ hang: true });
  assert.equal(await probeLaunch("/c", { spawn: hung.spawn, timeoutMs: 20 }), "slow");
  assert.equal(hung.calls[0].child.killed, true);
});

// A launch check over fake executables whose versions the test sets.
function checker(outcomes, { enabled = true } = {}) {
  const versions = new Map(Object.keys(outcomes).map((p) => [p, 1]));
  const probed = [];
  let clock = 0;
  const check = new BrowserLaunchCheck({
    enabled,
    now: () => clock,
    probe: async (p) => {
      probed.push(p);
      return outcomes[p];
    },
    stat: (p) => {
      if (!versions.has(p)) throw Object.assign(Error("gone"), { code: "ENOENT" });
      return { dev: 1, ino: 2, size: 3, mtimeMs: versions.get(p) };
    },
  });
  return {
    check,
    probed,
    versions,
    advance: (ms) => (clock += ms),
  };
}

test("apps are checked in order until one starts, each once per version", async () => {
  const { check, probed, versions } = checker({
    "/chromium": "sandbox",
    "/chrome": "ok",
    "/edge": "ok",
  });
  assert.equal(check.result("/chromium"), undefined);
  await check.prepare(["/chromium", "/chrome", "/edge"]);
  assert.deepEqual(probed, ["/chromium", "/chrome"]);
  assert.deepEqual(check.result("/chromium"), { ok: false, problem: "sandbox" });
  assert.deepEqual(check.result("/chrome"), { ok: true });
  assert.equal(check.result("/edge"), undefined);
  // Known results start nothing again.
  await check.prepare(["/chromium", "/chrome", "/edge"]);
  assert.deepEqual(probed, ["/chromium", "/chrome"]);
  // An updated executable is checked again.
  versions.set("/chrome", 2);
  assert.equal(check.result("/chrome"), undefined);
  await check.prepare(["/chrome"]);
  assert.deepEqual(probed, ["/chromium", "/chrome", "/chrome"]);
});

test("a failed app is checked again a minute later, and concurrent checks share", async () => {
  const outcomes = { "/chromium": "sandbox", "/chrome": "ok" };
  const { check, probed, advance } = checker(outcomes);
  await Promise.all([
    check.prepare(["/chromium", "/chrome"]),
    check.prepare(["/chromium", "/chrome"]),
  ]);
  assert.deepEqual(probed, ["/chromium", "/chrome"]);
  advance(30000);
  // The owner allowed user namespaces for Chromium meanwhile.
  outcomes["/chromium"] = "ok";
  await check.prepare(["/chromium", "/chrome"]);
  assert.deepEqual(probed, ["/chromium", "/chrome"]);
  advance(31000);
  await check.prepare(["/chromium", "/chrome"]);
  assert.deepEqual(probed, ["/chromium", "/chrome", "/chromium"]);
  assert.deepEqual(check.result("/chromium"), { ok: true });
});

test("a slow or throwing check counts as starting or crashed; off elsewhere", async () => {
  const { check } = checker({ "/slow": "slow" });
  await check.prepare(["/slow"]);
  assert.deepEqual(check.result("/slow"), { ok: true });
  const throwing = new BrowserLaunchCheck({
    enabled: true,
    probe: async () => {
      throw Error("boom");
    },
    stat: () => ({ dev: 1, ino: 1, size: 1, mtimeMs: 1 }),
  });
  await throwing.prepare(["/x"]);
  assert.deepEqual(throwing.result("/x"), { ok: false, problem: "crashed" });
  const off = checker({ "/chromium": "sandbox" }, { enabled: false });
  await off.check.prepare(["/chromium"]);
  assert.deepEqual(off.probed, []);
  assert.equal(off.check.result("/chromium"), undefined);
});

test("starts check the browser first, the status names a launch problem", async () => {
  const order = [];
  const launch = { name: "Chromium", problem: "sandbox", usable: true };
  const webTools = new WebToolsChanges({
    assistants: {},
    webSearch: { resolve: () => null },
    detect: () => {
      order.push("detect");
      return {
        available: true,
        name: "Chrome",
        executablePath: "/usr/bin/google-chrome",
        visible: { available: false, reason: "noApp" },
        launch,
      };
    },
    prepare: async () => {
      order.push("prepare");
      throw Error("a failing check never stops a start");
    },
  });
  const inputs = await hermesApplyWiring({
    bridge: { start: async () => null },
    webTools,
  }).hermesInputs();
  assert.deepEqual(order, ["prepare", "detect"]);
  assert.equal(inputs.browser.executablePath, "/usr/bin/google-chrome");
  const status = browserStatus(webTools);
  assert.deepEqual(status.launch, launch);
  assert.equal(status.name, "Chrome");
});
