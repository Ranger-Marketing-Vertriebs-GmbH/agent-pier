import test from "node:test";
import assert from "node:assert/strict";
import {
  requireProfile,
  requireRun,
  runSummary,
} from "../../server/features/mcp/tool-policy.js";

const grant = {
  id: "grant-one",
  ownedRunsOnly: true,
  projectIds: ["project"],
  accountIds: ["account"],
  connectionIds: ["connection"],
};
const profile = {
  config: { accountId: "account", providerConnectionId: "connection" },
  accountSnapshot: { id: "account" },
  providerConnectionSnapshot: { id: "connection" },
};
const run = { projectId: "project", nodes: [{ profileSnapshot: profile }] };

test("session-owned runs require the exact requesting grant even when resources are allowed", () => {
  assert.doesNotThrow(() => requireRun(grant, run, { grantId: "grant-one" }));
  for (const request of [undefined, {}, { grantId: "grant-two" }])
    assert.throws(() => requireRun(grant, run, request), { status: 403 });
  assert.doesNotThrow(() =>
    requireRun({ ...grant, ownedRunsOnly: false }, run, { grantId: "grant-two" }),
  );
});

test("a frozen profile must retain its authorized account and provider identities", () => {
  assert.doesNotThrow(() => requireProfile(grant, profile));
  for (const snapshot of ["accountSnapshot", "providerConnectionSnapshot"])
    assert.throws(
      () => requireProfile(grant, { ...profile, [snapshot]: { id: "foreign" } }),
      { status: 409 },
    );
  for (const resource of ["accountIds", "connectionIds"])
    assert.throws(() => requireProfile({ ...grant, [resource]: [] }, profile), {
      status: 403,
    });
});

test("provisioning runs use the reserved project without allowing an absent or foreign project", () => {
  const pending = { ...run, projectId: "" };
  const unrestricted = { ...grant, ownedRunsOnly: false };
  assert.doesNotThrow(() => requireRun(unrestricted, pending, { projectId: "project" }));
  for (const request of [undefined, {}, { projectId: "foreign" }])
    assert.throws(() => requireRun(unrestricted, pending, request), { status: 403 });
});

test("a parallel group is checked through its members and summarized with them", () => {
  const grouped = {
    ...run,
    nodes: [
      { id: "review", kind: "parallel", status: "running", members: ["security"] },
      {
        id: "security",
        group: "review",
        status: "running",
        profileSnapshot: {
          ...profile,
          id: "p",
          name: "Security",
          config: { ...profile.config, cliTool: "claude", models: { default: "" } },
        },
      },
    ],
  };
  assert.doesNotThrow(() => requireRun(grant, grouped, { grantId: "grant-one" }));
  const foreign = structuredClone(grouped);
  foreign.nodes[1].profileSnapshot.accountSnapshot.id = "foreign";
  assert.throws(() => requireRun(grant, foreign, { grantId: "grant-one" }), {
    status: 409,
  });
  assert.deepEqual(runSummary(grouped).nodes, [
    { id: "review", kind: "parallel", status: "running", members: ["security"] },
    {
      id: "security",
      group: "review",
      status: "running",
      profileId: "p",
      profileName: "Security",
      tool: "claude",
      model: "",
    },
  ]);
});
