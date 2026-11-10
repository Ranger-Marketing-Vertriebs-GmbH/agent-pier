import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applicationFixture } from "../helpers/application.js";
import { setupCodeFile } from "../../server/features/login/setup-code.js";

const owner = { username: "owner", password: "temporary-owner-password" };
const host = "agentpier.home.arpa";
const network = { enabled: true, bind: "127.0.0.1", hosts: [host] };

/** A request the way a device on the plain network sends it. */
function lan(f, endpoint, body) {
  const port = new URL(f.url).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      f.url + endpoint,
      {
        method: body ? "POST" : "GET",
        headers: {
          host: `${host}:${port}`,
          origin: `http://${host}:${port}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            cookie: res.headers["set-cookie"],
            data: data ? JSON.parse(data) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("the owner is created over the plain network only with the setup code", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false, network });
  const status = (await lan(f, "/auth/status")).data;
  assert.equal(status.canSetup, true);
  assert.equal(status.needsSetupCode, true);
  const code = fs.readFileSync(setupCodeFile(f.dataDir), "utf8").trim();
  for (const body of [owner, { ...owner, setupCode: "AAAA-AAAA-AAAA" }]) {
    const refused = await lan(f, "/auth/setup", body);
    assert.equal(refused.status, 403);
    assert.equal(refused.data.code, "LOGIN_SETUP_CODE_INVALID");
    assert.equal(refused.cookie, undefined);
  }
  assert.equal(f.application.login.configured, false);
  // The answers never carry the code.
  assert.equal(JSON.stringify(status).includes(code), false);
  const created = await lan(f, "/auth/setup", {
    ...owner,
    setupCode: code.toLowerCase(),
  });
  assert.equal(created.status, 201);
  assert.equal(f.application.login.configured, true);
  assert.equal(fs.existsSync(setupCodeFile(f.dataDir)), false);
  assert.equal((await lan(f, "/auth/status")).data.needsSetupCode, undefined);
});

test("guessing the setup code runs into the attempt limit", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false, network });
  await lan(f, "/auth/status");
  const code = fs.readFileSync(setupCodeFile(f.dataDir), "utf8").trim();
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt++)
    statuses.push(
      (await lan(f, "/auth/setup", { ...owner, setupCode: "AAAA-AAAA-AAAA" })).status,
    );
  assert.deepEqual(statuses, [...Array(10).fill(403), 429]);
  // Even the right code waits for the window now.
  assert.equal((await lan(f, "/auth/setup", { ...owner, setupCode: code })).status, 429);
  assert.equal(f.application.login.configured, false);
});

test("the AgentPier computer itself sets up the owner without a code", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false, network });
  const status = await (await f.request("/auth/status")).json();
  assert.equal(status.canSetup, true);
  assert.equal("needsSetupCode" in status, false);
  const created = await f.request("/auth/setup", { method: "POST", body: owner });
  assert.equal(created.status, 201);
});
