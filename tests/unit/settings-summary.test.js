import test from "node:test";
import assert from "node:assert/strict";
import { settingsSummary } from "../../server/features/settings/settings-summary.js";

const now = Date.parse("2026-10-12T12:00:00Z");
const grants = [
  { revokedAt: null, expiresAt: "2026-11-01T00:00:00Z" },
  { revokedAt: "2026-10-01T00:00:00Z", expiresAt: null },
  { revokedAt: null, expiresAt: "2026-10-01T00:00:00Z" },
  { revokedAt: null, expiresAt: null },
];
const services = {
  mcpAccess: {
    status: () => ({ available: true }),
    listGrants: ({ offset, limit }) => ({
      grants: grants.slice(offset, offset + Math.min(limit, 3)),
      total: grants.length,
    }),
  },
  effectiveConfig: () => ({
    remoteUrl: "https://host.ts.net",
    network: { enabled: false },
  }),
  sshAccesses: { list: () => [{ id: "a" }, { id: "b" }] },
  repositories: { listCredentials: () => [{ id: "g" }] },
  users: { list: () => [{ id: "u1" }, { id: "u2" }, { id: "u3" }] },
  operations: {
    report: () => ({
      generatedAt: "2026-10-12T08:00:00Z",
      checks: [
        { status: "ok" },
        { status: "fail" },
        { status: "warn" },
        { status: "skip" },
      ],
    }),
    backup: {
      list: () => [{ createdAt: "2026-10-11T22:00:00Z" }, { createdAt: "2026-10-01" }],
    },
    releases: {
      status: () => ({ current: "1.28.1" }),
      lastCheck: () => ({ version: "1.29.0", upToDate: false }),
    },
  },
};

test("the summary reports every row from local state", () => {
  assert.deepEqual(settingsSummary(services, now), {
    access: {
      mcp: { available: true, activeGrants: 2 },
      remote: { tailscale: true, network: false, restartRequired: null },
      ssh: { count: 2 },
      github: { count: 1 },
      users: { count: 3 },
    },
    operations: {
      diagnostics: { generatedAt: "2026-10-12T08:00:00Z", failed: 1, warnings: 1 },
      backups: { count: 2, lastAt: "2026-10-11T22:00:00Z" },
      updates: { current: "1.28.1", checked: true, available: "1.29.0" },
    },
  });
});

test("missing or failing sources are null, never a made-up zero", () => {
  const summary = settingsSummary(
    {
      ...services,
      mcpAccess: undefined,
      users: undefined,
      sshAccesses: {
        list: () => {
          throw new Error("unreadable");
        },
      },
      operations: {
        ...services.operations,
        report: () => null,
        backup: { list: () => [] },
        releases: {
          status: () => ({ current: "1.29.0" }),
          lastCheck: () => ({ version: "1.29.0" }),
        },
      },
    },
    now,
  );
  assert.equal(summary.access.mcp, null);
  assert.equal(summary.access.users, null);
  assert.equal(summary.access.ssh, null);
  assert.equal(summary.operations.diagnostics, null);
  assert.deepEqual(summary.operations.backups, { count: 0, lastAt: null });
  assert.deepEqual(summary.operations.updates, {
    current: "1.29.0",
    checked: true,
    available: null,
  });
});
