import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { devicesApp } from "./devices-app.js";

/**
 * An application whose devices run on the fake SDK (devices-app.js) and whose coding
 * CLI is a stand-in that stays alive: `launch(extra)` starts a Codex session of the
 * fixture project through `POST /api/sessions`, `device(name)` creates a device of
 * the owner's, and `access(session)` / `assign(session, body)` read and set the
 * session's device access through its routes.
 */
export async function sessionDevicesApp(t, options) {
  const app = await devicesApp(t, options);
  const { f } = app;
  const executable = path.join(f.root, "idle-cli.cjs");
  fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, {
    mode: 0o700,
  });
  f.application.accounts.command = () => ({ command: executable, args: [], env: {} });
  const route = (session) => `/api/sessions/${session.id}/devices`;
  return {
    ...app,
    route,
    async launch(extra = {}) {
      const response = await f.request("/api/sessions", {
        method: "POST",
        body: { accountId: "local-codex", cwd: f.project, agentbus: false, ...extra },
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      return JSON.parse(text);
    },
    async device(name = "Pixel") {
      const response = await f.request("/api/devices", {
        method: "POST",
        body: { name },
      });
      assert.equal(response.status, 201);
      return response.json();
    },
    access: async (session) => (await f.request(route(session))).json(),
    assign: (session, body) => f.request(route(session), { method: "PUT", body }),
  };
}
