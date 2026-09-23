import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { applicationFixture } from "../helpers/application.js";
import { workspaceRoutes } from "../../server/http/routes/workspace.js";
import { registerResponses } from "../../server/http/responses.js";

// Full-application coverage (needs the real session manager, which starts a
// tmux socket outside this suite's control). See task-5-report.md for why
// this cannot run in a sandboxed CI shell.
test("sandbox profiles are reported over HTTP without leaking filesystem paths", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/sandbox-profiles");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.available, "boolean");
  assert.ok(Array.isArray(body.profiles));
  for (const name of body.profiles) assert.ok(!name.includes("/"), "no paths");
});

test("a non-string sandbox profile is rejected", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/sessions", {
    method: "POST",
    body: { tool: "shell", accountId: "local-shell", nonoProfile: 7 },
  });
  assert.ok(response.status >= 400 && response.status < 500);
});

// Route-level coverage against a stubbed nonoSandbox service, independent of
// the session manager: deterministic even on a host with nono on PATH.
function workspaceApp(nonoSandbox) {
  const application = express();
  application.use(express.json());
  application.use("/api", workspaceRoutes({ nonoSandbox }));
  registerResponses(application);
  return application;
}
async function get(application, path) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("sandbox profiles are unavailable when nono is undetected", async () => {
  const application = workspaceApp({ executable: () => null });
  assert.deepEqual(await get(application, "/api/sandbox-profiles"), {
    status: 200,
    body: { available: false, profiles: [] },
  });
});

test("sandbox profiles are listed by name when nono is detected", async (t) => {
  // A fake nono binary, so the assertion never depends on this machine's own
  // installed sandbox profiles: it prints a fixed "nono profile list" output
  // regardless of the arguments the route passes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-nono-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeNono = path.join(root, "nono");
  fs.writeFileSync(
    fakeNono,
    [
      "#!/bin/sh",
      'echo "nono profile: 2 profiles"',
      'echo "  Built-in:"',
      'echo "    dev  development sandbox profile  extends base"',
      'echo "    ci  continuous-integration sandbox profile  extends base"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const application = workspaceApp({ executable: () => fakeNono });
  const { status, body } = await get(application, "/api/sandbox-profiles");
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.deepEqual(body.profiles, ["dev", "ci"]);
});
