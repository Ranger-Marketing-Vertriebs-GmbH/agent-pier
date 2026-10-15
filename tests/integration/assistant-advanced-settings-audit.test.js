import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { assistantAdvancedSettingsRoutes } from "../../server/http/routes/assistant-advanced-settings.js";
import { registerResponses } from "../../server/http/responses.js";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/openclaw-config/overrides.js";
import { advancedSettingsRuntime } from "../../server/features/assistants/openclaw-config/advanced-settings.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";

/** The real route over the real service, override store and audit store. */
async function app(t, { runtime, synchronization = {} }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "advanced-settings-audit-"));
  const audit = new AuditStore({ dataDir });
  t.after(() => {
    audit.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const advanced = new AdvancedConfig({
    assistants: { runtime, admit: (operation) => operation() },
    overrides,
    synchronization,
    audit,
  });
  const application = express();
  application.use(express.json());
  application.use(
    "/api",
    assistantAdvancedSettingsRoutes({ assistantAdvancedConfig: advanced }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const put = async (body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/assistant-advanced-settings`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  // Oldest first; only what the audit store kept.
  const events = () =>
    audit
      .export()
      .map(({ action, resourceType, resourceId, source, outcome, details }) => ({
        action,
        resourceType,
        resourceId,
        source,
        outcome,
        details,
      }));
  return { put, events };
}

const stopped = { status: () => ({ availability: "disabled", version: null }) };

test("advanced setting changes reach the audit log with the setting and its values", async (t) => {
  const { put, events } = await app(t, { runtime: stopped });
  for (const [target, value] of [
    ["agents.defaults.timeoutSeconds", 3600],
    ["agents.defaults.timeoutSeconds", 7200],
    ["agents.defaults.thinkingDefault", "high"],
    ["agents.defaults.userTimezone", "Europe/Berlin"],
    ["agents.defaults.imageQuality", "balanced"],
    ["agents.defaults.imageMaxDimensionPx", 1600],
    ["attachments.ttlHours", 72],
    ["attachments.ttlHours", null],
  ]) {
    const saved = await put({ path: target, value });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const updated = (resourceId, from, to) => ({
    action: "setting.updated",
    resourceType: "setting",
    resourceId,
    source: "user",
    outcome: "success",
    details: { setting: resourceId, from, to },
  });
  assert.deepEqual(events(), [
    updated("runTimeout", null, 3600),
    updated("runTimeout", 3600, 7200),
    updated("thinkingDefault", null, "high"),
    updated("userTimezone", null, "Europe/Berlin"),
    updated("imageQuality", null, "balanced"),
    updated("imageMaxDimension", null, 1600),
    updated("mediaRetention", null, 72),
    updated("mediaRetention", 72, null),
  ]);
});

test("a change undone after a failed Gateway restart is audited as rolled back", async (t) => {
  const runtime = {
    status: () => ({ availability: "ready", version: advancedSettingsRuntime }),
    client: {
      ready: true,
      call: async (method) =>
        method === "config.schema.lookup" ? { reloadKind: "restart" } : { config: {} },
    },
  };
  const synchronization = {
    async restartGateway(persist) {
      persist();
      throw new Error("/private/openclaw.json: restart failed");
    },
  };
  const { put, events } = await app(t, { runtime, synchronization });
  const failed = await put({
    path: "attachments.ttlHours",
    value: 96,
    confirmRestart: true,
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(
    events().map(({ action, outcome, resourceId, details }) => [
      action,
      outcome,
      resourceId,
      details,
    ]),
    [
      [
        "setting.updated",
        "success",
        "mediaRetention",
        { setting: "mediaRetention", from: null, to: 96 },
      ],
      [
        "setting.rolled-back",
        "failure",
        "mediaRetention",
        { setting: "mediaRetention", from: 96, to: null },
      ],
    ],
  );
});
