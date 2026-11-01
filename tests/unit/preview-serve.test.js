import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPreviewServe,
  previewServeOwned,
  removePreviewServe,
  serveCommands,
} from "../../server/features/previews/preview-serve.js";
import {
  runTailscale,
  tailscaleArgs,
} from "../../server/features/remote/tailscale-cli.js";
import {
  listenerOffset,
  listenerPort,
  TAILSCALE_LISTENER_OFFSET,
} from "../../server/features/previews/preview-slots.js";

/** A Web entry of `serve status --json` proxying `/` of `host:port` to `target`. */
const web = (port, target, host = "box.tail.ts.net") => ({
  [`${host}:${port}`]: { Handlers: { "/": { Proxy: target } } },
});

/** A fake `tailscale` recording its arguments; `status` is the canned serve status. */
function fakeRun(status = {}, { fail } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (fail?.(args)) throw Object.assign(new Error("boom"), { stderr: "denied\n" });
    if (args.join(" ") === "serve status --json") return JSON.stringify(status);
    return "";
  };
  return { run, calls };
}

const writes = (calls) => calls.filter((args) => args[1] !== "status");

test("the Tailscale listener offset applies only with a remote URL and network mode off", () => {
  assert.equal(TAILSCALE_LISTENER_OFFSET, 1000);
  assert.equal(listenerPort(47100), 47100);
  assert.equal(listenerPort(47100, { offset: 1000 }), 48100);
  assert.equal(listenerOffset({}), 0);
  assert.equal(listenerOffset({ remoteUrl: "https://box.tail.ts.net" }), 1000);
  assert.equal(
    listenerOffset({ remoteUrl: "https://box.tail.ts.net", network: { enabled: true } }),
    0,
  );
  assert.equal(listenerOffset({ network: { enabled: true } }), 0);
});

test("registers every free slot of the range once", async () => {
  const { run, calls } = fakeRun({});
  const result = await applyPreviewServe({ run, range: { start: 47100, end: 47101 } });
  assert.deepEqual(writes(calls), [
    ["serve", "--bg", "--https=47100", "http://127.0.0.1:48100"],
    ["serve", "--bg", "--https=47101", "http://127.0.0.1:48101"],
  ]);
  assert.deepEqual(result, { registered: [47100, 47101], failed: [], commands: [] });
});

test("an owned slot is left alone; a foreign Web or TCP entry is reported as failed", async () => {
  const status = {
    TCP: { 47102: { HTTPS: true } },
    Web: {
      ...web(47100, "http://127.0.0.1:48100"),
      ...web(47101, "http://127.0.0.1:3000"),
    },
  };
  const { run, calls } = fakeRun(status);
  const result = await applyPreviewServe({ run, range: { start: 47100, end: 47103 } });
  assert.deepEqual(writes(calls), [
    ["serve", "--bg", "--https=47103", "http://127.0.0.1:48103"],
  ]);
  assert.deepEqual(result.registered, [47100, 47103]);
  assert.deepEqual(result.failed, [
    { port: 47101, reason: "occupied" },
    { port: 47102, reason: "occupied" },
  ]);
  // Another program's entry is never overwritten, not even by a copied command.
  assert.deepEqual(result.commands, []);
});

test("previewServeOwned follows the selectServePort rule", () => {
  const target = "http://127.0.0.1:48100";
  assert.equal(previewServeOwned({ Web: web(47100, target) }, 47100, 48100), true);
  assert.equal(previewServeOwned({}, 47100, 48100), false);
  assert.equal(previewServeOwned({ Web: web(47100, target) }, 47100, 48101), false);
  const two = {
    Web: { "box.tail.ts.net:47100": { Handlers: { "/": { Proxy: target }, "/x": {} } } },
  };
  assert.equal(previewServeOwned(two, 47100, 48100), false);
  const hosts = { Web: { ...web(47100, target), ...web(47100, target, "other.ts.net") } };
  assert.equal(previewServeOwned(hosts, 47100, 48100), false);
});

test("a range change removes only AgentPier's own old registrations", async () => {
  const status = {
    Web: {
      ...web(47100, "http://127.0.0.1:48100"),
      ...web(47101, "http://127.0.0.1:3000"),
    },
  };
  const { run, calls } = fakeRun(status);
  await applyPreviewServe({
    run,
    range: { start: 47200, end: 47200 },
    previousRange: { start: 47100, end: 47101 },
  });
  assert.deepEqual(writes(calls), [
    ["serve", "--https=47100", "off"],
    ["serve", "--bg", "--https=47200", "http://127.0.0.1:48200"],
  ]);
});

test("removePreviewServe unregisters owned slots only", async () => {
  const status = {
    Web: {
      ...web(47100, "http://127.0.0.1:48100"),
      ...web(47101, "http://127.0.0.1:3000"),
    },
  };
  const { run, calls } = fakeRun(status);
  const result = await removePreviewServe({ run, range: { start: 47100, end: 47102 } });
  assert.deepEqual(writes(calls), [["serve", "--https=47100", "off"]]);
  assert.deepEqual(result, { removed: [47100] });
});

test("a failing CLI yields the exact commands to run", async () => {
  const { run } = fakeRun({}, { fail: (args) => args.includes("--bg") });
  const result = await applyPreviewServe({ run, range: { start: 47100, end: 47101 } });
  assert.deepEqual(result.registered, []);
  assert.equal(result.failed[0].port, 47100);
  assert.equal(result.failed[0].reason, "denied");
  assert.deepEqual(result.commands, [
    "tailscale serve --bg --https=47100 http://127.0.0.1:48100",
    "tailscale serve --bg --https=47101 http://127.0.0.1:48101",
  ]);
  const unreadable = await applyPreviewServe({
    run: async () => {
      throw new Error("no tailscale");
    },
    range: { start: 47100, end: 47100 },
  });
  assert.deepEqual(unreadable.failed, [{ port: 47100, reason: "no tailscale" }]);
  assert.deepEqual(unreadable.commands, serveCommands({ start: 47100, end: 47100 }));
});

test("serveCommands prints the loopback listener of every slot", () =>
  assert.deepEqual(serveCommands({ start: 47100, end: 47101 }), [
    "tailscale serve --bg --https=47100 http://127.0.0.1:48100",
    "tailscale serve --bg --https=47101 http://127.0.0.1:48101",
  ]));

test("the socket variable must be absolute", () => {
  assert.throws(() => tailscaleArgs(["status"], { AGENTPIER_TAILSCALE_SOCKET: "rel" }), {
    message: /socket must be an absolute path/,
  });
  assert.throws(() =>
    tailscaleArgs(["status"], { AGENTPIER_TAILSCALE_SOCKET: "/run/ts\n.sock" }),
  );
  assert.deepEqual(tailscaleArgs(["status"], {}), ["status"]);
  assert.deepEqual(
    tailscaleArgs(["status"], { AGENTPIER_TAILSCALE_SOCKET: "/run/ts.sock" }),
    ["--socket=/run/ts.sock", "status"],
  );
});

test("runTailscale runs the CLI asynchronously with a 30 second timeout", async () => {
  const seen = [];
  const execFile = (file, args, options, done) => {
    seen.push({ file, args, timeout: options.timeout });
    done(null, "ok\n", "");
  };
  assert.equal(await runTailscale(["status"], { env: {}, execFile }), "ok\n");
  assert.deepEqual(seen, [{ file: "tailscale", args: ["status"], timeout: 30000 }]);
  const failing = (file, args, options, done) => done(new Error("exit 1"), "", "denied");
  await assert.rejects(runTailscale(["status"], { env: {}, execFile: failing }), {
    stderr: "denied",
  });
  await assert.rejects(
    runTailscale(["status"], { env: { AGENTPIER_TAILSCALE_SOCKET: "rel" }, execFile }),
    /absolute path/,
  );
});
