import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { packageProblem } from "../../server/features/mcp-packages/package-errors.js";

async function app(t, skills) {
  const application = express();
  application.use(express.json());
  application.use(
    "/api",
    mcpServerRoutes({
      mcpServerChanges: { list: () => [] },
      mcpServers: { get: () => ({ id: "s1" }) },
      audit: { append: () => {} },
      mcpPackages: { skills },
    }),
  );
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

test("package skills are listed and installed only with the owner's confirmation", async (t) => {
  const seen = [];
  const request = await app(t, {
    list: (id) => ({ name: "x", version: "1.0.0", skills: [], id }),
    install: (id, body) => {
      seen.push({ id, body });
      if (body.confirmInstall !== true)
        throw packageProblem("MCP_PACKAGE_CONFIRMATION_REQUIRED", 409);
      return [{ name: "reverse-it" }];
    },
  });
  const listed = await request("GET", "/api/mcp-servers/s1/package/skills");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.id, "s1");
  const refused = await request("POST", "/api/mcp-servers/s1/package/skills", {
    profileId: "local-claude",
    names: ["reverse-it"],
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  const accepted = await request("POST", "/api/mcp-servers/s1/package/skills", {
    profileId: "local-claude",
    names: ["reverse-it"],
    confirmInstall: true,
  });
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.body, [{ name: "reverse-it" }]);
  assert.equal(seen.length, 2);
});

test("package skills answer 503 when skills are not wired", async (t) => {
  const request = await app(t, null);
  assert.equal((await request("GET", "/api/mcp-servers/s1/package/skills")).status, 503);
});
