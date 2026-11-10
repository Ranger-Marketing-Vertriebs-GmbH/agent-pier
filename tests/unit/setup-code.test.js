import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SetupCode,
  setupCodeFile,
  startupSetupCode,
} from "../../server/features/login/setup-code.js";
import { setupNeedsCode } from "../../server/http/login.js";
import { runSetupCode } from "../../scripts/setup-code.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-setup-code-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, setupCode: new SetupCode({ dataDir }) };
}

test("the setup code is created once, kept private and forgiving about how it is typed", (t) => {
  const { dataDir, setupCode } = fixture(t);
  assert.equal(setupCode.read(), null);
  assert.equal(setupCode.matches(""), false);
  const code = setupCode.current();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(setupCode.current(), code);
  assert.equal(new SetupCode({ dataDir }).current(), code);
  assert.equal(fs.statSync(setupCodeFile(dataDir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(setupCodeFile(dataDir))).mode & 0o777, 0o700);
  for (const typed of [code, code.toLowerCase(), code.replaceAll("-", ""), ` ${code} `])
    assert.equal(setupCode.matches(typed), true, typed);
  const other = code.startsWith("A") ? "B" + code.slice(1) : "A" + code.slice(1);
  for (const wrong of [other, code.slice(0, -1), code + "A", "", undefined, 7, [code]])
    assert.equal(setupCode.matches(wrong), false);
  setupCode.clear();
  assert.equal(setupCode.matches(code), false);
  assert.notEqual(setupCode.current(), code);
});

test("a damaged code file never matches and is replaced", (t) => {
  const { dataDir, setupCode } = fixture(t);
  fs.mkdirSync(path.dirname(setupCodeFile(dataDir)), { recursive: true });
  fs.writeFileSync(setupCodeFile(dataDir), "\n");
  assert.equal(setupCode.matches(""), false);
  assert.match(setupCode.current(), /^.{4}-.{4}-.{4}$/);
});

test("only a plain network request needs the code", () => {
  const config = { port: 4380, remoteUrl: "https://host.example.ts.net" };
  const request = (host, trustBranch, remoteAddress = "127.0.0.1", headers = {}) => ({
    headers: { host, ...headers },
    socket: { remoteAddress },
    trustBranch,
  });
  assert.equal(setupNeedsCode(request("127.0.0.1:4380", "local"), config), false);
  assert.equal(
    setupNeedsCode(
      request("host.example.ts.net", "tailscale", "127.0.0.1", {
        "tailscale-user-login": "o@example.test",
      }),
      config,
    ),
    false,
  );
  assert.equal(
    setupNeedsCode(request("192.168.1.20:4380", "network", "192.168.1.55"), config),
    true,
  );
  // A reverse proxy on the computer itself is still the network.
  assert.equal(setupNeedsCode(request("pier.home.arpa:4380", "network"), config), true);
});

test("the service prints a code at start only while the network can create the owner", (t) => {
  const { setupCode } = fixture(t);
  const open = { setupCode, configured: false, hasUsers: false, networkEnabled: true };
  assert.equal(startupSetupCode({ ...open, networkEnabled: false }), null);
  assert.equal(startupSetupCode({ ...open, hasUsers: true }), null);
  assert.equal(setupCode.read(), null);
  const code = startupSetupCode(open);
  assert.equal(code, setupCode.read());
  assert.equal(startupSetupCode({ ...open, configured: true }), null);
  assert.equal(setupCode.read(), null);
});

test("npm run setup-code prints the code the service checks, and none once an owner exists", (t) => {
  const { dataDir, setupCode } = fixture(t);
  const lines = [];
  assert.equal(runSetupCode({ dataDir, log: (line) => lines.push(line) }), 0);
  const code = setupCode.read();
  assert.ok(code);
  assert.ok(lines[0].includes(code));
  runSetupCode({ dataDir, log: (line) => lines.push(line) });
  assert.ok(lines[1].includes(code));
  fs.writeFileSync(
    path.join(dataDir, "login", "auth.json"),
    JSON.stringify({ user: { username: "owner" }, sessions: [] }),
  );
  runSetupCode({ dataDir, log: (line) => lines.push(line) });
  assert.equal(lines[2].includes(code), false);
  assert.equal(setupCode.read(), null);
});

test("the service and remote commands name the code only while the network can create the owner", async (t) => {
  const { dataDir, setupCode } = fixture(t);
  const { setupCodeNotice } = await import("../../scripts/setup-code.mjs");
  assert.equal(setupCodeNotice({ dataDir, networkEnabled: false }), null);
  assert.equal(setupCode.read(), null);
  const notice = setupCodeNotice({ dataDir, networkEnabled: true });
  assert.ok(notice.includes(setupCode.read()));
  // Users without an owner: the network cannot create the owner, so no code is offered.
  fs.mkdirSync(path.join(dataDir, "users"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "users", "users.json"),
    JSON.stringify({ version: 1, users: [{ id: "u1" }], sessions: [] }),
  );
  assert.equal(setupCodeNotice({ dataDir, networkEnabled: true }), null);
  const lines = [];
  runSetupCode({ dataDir, log: (line) => lines.push(line) });
  assert.equal(lines[0].includes(setupCode.read()), false);
  fs.rmSync(path.join(dataDir, "users"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "login", "auth.json"),
    JSON.stringify({ user: { username: "owner" }, sessions: [] }),
  );
  assert.equal(setupCodeNotice({ dataDir, networkEnabled: true }), null);
});
