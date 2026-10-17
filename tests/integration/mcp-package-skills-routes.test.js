import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { installed, skillDir } from "../helpers/mcp-package-skills.js";

async function app(t, services) {
  const application = express();
  application.use(express.json());
  application.use("/api", mcpServerRoutes({ audit: { append: () => {} }, ...services }));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const s = application.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  return async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("the skills routes list a package's skills and copy them only once confirmed", async (t) => {
  const { s, server } = await installed(t);
  const request = await app(t, {
    mcpServerChanges: s.changes,
    mcpServers: s.servers,
    mcpPackages: s.packages,
  });
  const url = `/api/mcp-servers/${server.id}/package/skills`;
  const listed = await request("GET", url);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.skills.map((skill) => skill.name),
    ["reverse-it", "second"],
  );
  assert.equal(JSON.stringify(listed.body).includes(s.root), false);
  const body = { profileId: "local-claude", names: ["reverse-it"] };
  for (const confirmInstall of [undefined, "true", 1]) {
    const refused = await request("POST", url, { ...body, confirmInstall });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  }
  assert.equal(fs.existsSync(skillDir(s)), false);
  const accepted = await request("POST", url, { ...body, confirmInstall: true });
  assert.equal(accepted.status, 201);
  assert.deepEqual(
    accepted.body.skills.find((skill) => skill.name === "reverse-it").installed,
    [{ profileId: "local-claude", version: "1.0.0" }],
  );
  assert.equal(JSON.stringify(accepted.body).includes(s.root), false);
  assert.equal(fs.existsSync(skillDir(s)), true);
});

test("package skills answer 503 when skills are not wired", async (t) => {
  const request = await app(t, {
    mcpServerChanges: { list: () => [] },
    mcpServers: { get: () => ({ id: "s1" }) },
    mcpPackages: { skills: null },
  });
  assert.equal((await request("GET", "/api/mcp-servers/s1/package/skills")).status, 503);
});
