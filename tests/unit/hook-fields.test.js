import test from "node:test";
import assert from "node:assert/strict";
import {
  curlSample,
  hookAddress,
  hookDraft,
  hookPatch,
  hookState,
  tickLock,
} from "../../web/features/assistants/settings/hook-fields.js";

const hook = {
  id: "h1",
  name: "Uptime",
  sender: "Uptime Kuma",
  instruction: "Check the server.",
  rights: {
    notify: true,
    telegram: false,
    research: true,
    coding: false,
    shell: "off",
    sshHosts: ["b", "a"],
    folders: { p2: "write", p1: "read" },
    memory: false,
    mcp: false,
  },
  hourlyLimit: 20,
  enabled: true,
  active: true,
  secretSet: true,
  revision: 4,
};

test("hookDraft flattens a hook into stable draft values", () => {
  assert.deepEqual(hookDraft(hook), {
    name: "Uptime",
    sender: "Uptime Kuma",
    instruction: "Check the server.",
    notify: true,
    telegram: false,
    research: true,
    coding: false,
    memory: false,
    mcp: false,
    shell: "off",
    sshHosts: ["a", "b"],
    folders: { p1: "read", p2: "write" },
    hourlyLimit: 20,
    enabled: true,
  });
  assert.equal(hookDraft({ ...hook, instruction: null }).instruction, "");
});

test("hookPatch sends only changed fields with the hook's revision", () => {
  assert.deepEqual(hookPatch(hookDraft(hook), hook), { revision: 4 });
  assert.deepEqual(hookPatch({ ...hookDraft(hook), name: "Uptime 2" }, hook), {
    revision: 4,
    name: "Uptime 2",
  });
  assert.deepEqual(hookPatch({ ...hookDraft(hook), enabled: false }, hook), {
    revision: 4,
    enabled: false,
  });
});

test("hookPatch sends every right when one changed, stored ones unchanged", () => {
  // A right above a lowered ceiling (research here) goes back as stored (R30).
  const patch = hookPatch({ ...hookDraft(hook), notify: false }, hook);
  assert.deepEqual(patch, {
    revision: 4,
    rights: {
      notify: false,
      telegram: false,
      research: true,
      coding: false,
      shell: "off",
      sshHosts: ["a", "b"],
      folders: { p1: "read", p2: "write" },
      memory: false,
      mcp: false,
    },
  });
});

test("hookAddress prefers Tailscale, then the network, then loopback", () => {
  const local = "http://127.0.0.1:4380/hooks/h1";
  assert.equal(hookAddress({ local, tailscale: null, network: [] }), local);
  assert.equal(
    hookAddress({ local, tailscale: null, network: ["http://10.0.0.2:4380/hooks/h1"] }),
    "http://10.0.0.2:4380/hooks/h1",
  );
  assert.equal(
    hookAddress({ local, tailscale: "https://pier.ts.net/hooks/h1", network: ["x"] }),
    "https://pier.ts.net/hooks/h1",
  );
});

test("curlSample is the documented one-line request", () => {
  assert.equal(
    curlSample("<secret>", "http://127.0.0.1:4380/hooks/h1"),
    `curl -X POST -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" -d '{"id":"1","message":"test"}' http://127.0.0.1:4380/hooks/h1`,
  );
});

test("hookState names why a hook does not wake its agent", () => {
  assert.equal(hookState(hook), "active");
  assert.equal(hookState({ ...hook, secretSet: false }), "noSecret");
  assert.equal(hookState({ ...hook, enabled: false, active: false }), "paused");
  assert.equal(hookState({ ...hook, active: false }), "inactive");
});

test("tickLock lets a stale right be switched off but never on", () => {
  const ceiling = { telegram: true, research: false };
  // Research stored on after the agent lost web access: shown with its reason, still
  // switchable off (lowering is always allowed); once off it is locked.
  assert.deepEqual(tickLock("research", ceiling, { research: true }), {
    reason: "missing",
    locked: false,
  });
  assert.deepEqual(tickLock("research", ceiling, { research: false }), {
    reason: "missing",
    locked: true,
  });
  assert.deepEqual(tickLock("telegram", ceiling, { notify: false, telegram: false }), {
    reason: "needsNotify",
    locked: true,
  });
  assert.deepEqual(tickLock("telegram", ceiling, { notify: true, telegram: false }), {
    reason: null,
    locked: false,
  });
  assert.deepEqual(tickLock("notify", ceiling, { notify: false }), {
    reason: null,
    locked: false,
  });
});
