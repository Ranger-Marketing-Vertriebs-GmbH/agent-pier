import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRemote, parseRemoteArguments } from "../../scripts/remote.mjs";
import { AuditStore } from "../../server/features/audit/audit-store.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-script-"));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 4390 }));
  const lines = [],
    restarts = [];
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const run = (argv, options = {}) =>
    runRemote({
      argv,
      dataDir,
      port: 4390,
      log: (line) => lines.push(String(line)),
      restart: async () => restarts.push(argv[0]),
      health: async () => true,
      detect: () => ({ addresses: ["192.168.1.20"], hostname: "macmini" }),
      fetchImpl: async () => ({ json: async () => ({ instanceId: "before" }) }),
      ...options,
    });
  const saved = () =>
    JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  return { run, lines, restarts, saved, dataDir };
}
test("argument parsing covers every command and flag", () => {
  assert.deepEqual(
    parseRemoteArguments([
      "enable",
      "--bind",
      "::",
      "--host",
      "a.example",
      "--host",
      "b.example",
      "--accept-plain-http",
      "--no-restart",
    ]),
    {
      command: "enable",
      bind: "::",
      hosts: ["a.example", "b.example"],
      add: [],
      remove: [],
      accept: true,
      restart: false,
    },
  );
  assert.deepEqual(
    parseRemoteArguments(["hosts", "--add", "c.example", "--remove", "a.example"]).add,
    ["c.example"],
  );
  assert.equal(parseRemoteArguments(["enable"]).bind, undefined);
  assert.throws(() => parseRemoteArguments(["explode"]), /status|enable|disable|hosts/);
  assert.throws(() => parseRemoteArguments(["enable", "--bind"]), /--bind/);
});
test("enable requires the explicit plain-HTTP acceptance", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(["enable", "--host", "a.example"]), 2);
  assert.equal(f.saved().network, undefined);
  assert.equal(f.lines.join("\n").includes("--accept-plain-http"), true);
});
test("enable, hosts and disable write the configuration, restart and print URLs", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(["enable", "--host", "a.example", "--accept-plain-http"]), 0);
  assert.deepEqual(f.saved().network, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["a.example"],
  });
  assert.equal(f.saved().port, 4390);
  assert.equal(
    f.lines.some((line) => line.includes("http://a.example:4390")),
    true,
  );
  assert.equal(
    f.lines.some((line) => line.includes("http://192.168.1.20:4390")),
    true,
  );
  assert.deepEqual(f.restarts, ["enable"]);
  assert.equal(await f.run(["hosts", "--add", "b.example", "--remove", "a.example"]), 0);
  assert.deepEqual(f.saved().network.hosts, ["b.example"]);
  assert.equal(await f.run(["disable", "--no-restart"]), 0);
  assert.deepEqual(f.saved().network, {
    enabled: false,
    bind: "0.0.0.0",
    hosts: ["b.example"],
  });
  assert.deepEqual(f.restarts, ["enable", "hosts"]);
  assert.equal(await f.run(["status"]), 0);
  assert.equal(
    f.lines.slice(-4).some((line) => line.includes("http://b.example:4390")),
    true,
  );
});
test("a missing service prints the manual restart hint and a failed health check fails", async (t) => {
  const f = fixture(t);
  const code = await f.run(["enable", "--accept-plain-http"], {
    restart: async () => {
      throw Object.assign(new Error("not installed"), { status: 503 });
    },
  });
  assert.equal(code, 1);
  assert.equal(f.lines.join("\n").includes("service:install"), true);
  const failed = await f.run(["disable"], { health: async () => false });
  assert.equal(failed, 1);
});
test("an invalid --bind value is rejected, writes nothing and records a failed audit row", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(["enable", "--bind", "not-an-ip", "--accept-plain-http"]), {
    status: 400,
  });
  assert.equal(f.saved().network, undefined);
  const audit = new AuditStore({ dataDir: f.dataDir });
  assert.equal(audit.list({ action: "setting.failed" }).events.length, 1);
  audit.close();
});
test("the audit row records the mode, the bind and the host count", async (t) => {
  const f = fixture(t);
  await f.run(["enable", "--bind", "::", "--host", "a.example", "--accept-plain-http"]);
  const audit = new AuditStore({ dataDir: f.dataDir });
  const events = audit.list({ action: "setting.updated" }).events;
  audit.close();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].details, { enabled: true, bind: "::", count: 1 });
});
test("hosts --remove reports names that are not in the list and leaves it unchanged", async (t) => {
  const f = fixture(t);
  await f.run(["enable", "--host", "a.example", "--accept-plain-http"]);
  const code = await f.run(["hosts", "--remove", "missing.example"]);
  assert.equal(code, 0);
  assert.deepEqual(f.saved().network.hosts, ["a.example"]);
  assert.equal(
    f.lines.some((line) => line.includes("missing.example steht nicht in der Hostliste")),
    true,
  );
});
test("enable keeps the configured bind unless --bind is given", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(["enable", "--bind", "::", "--accept-plain-http"]), 0);
  assert.equal(f.saved().network.bind, "::");
  await f.run(["disable", "--no-restart"]);
  assert.equal(await f.run(["enable", "--accept-plain-http"]), 0);
  assert.equal(f.saved().network.bind, "::");
});
test("the health check compares against the instance id read before the restart", async (t) => {
  const f = fixture(t);
  const checks = [];
  const health = async (options) => {
    checks.push(options);
    return true;
  };
  assert.equal(await f.run(["disable"], { health }), 0);
  assert.equal(checks[0].previousInstanceId, "before");
  assert.equal(checks[0].port, 4390);
  await f.run(["disable"], {
    health,
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(checks[1].previousInstanceId, undefined);
});
