import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  PreviewSlots,
  listenerPort,
} from "../../server/features/previews/preview-slots.js";
import {
  forbiddenTarget,
  targetAddress,
} from "../../server/features/previews/preview-targets.js";
import { freePortRange } from "../helpers/preview-ports.js";

const file = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slots-")), "previews", "slots.json");
const range = { start: 41000, end: 41002 };

test("freePortRange avoids the default preview range", async () => {
  const found = await freePortRange(3);
  assert.ok(found.start >= 40000 && found.end < 45000 && found.end - found.start === 2);
});

test("allocation prefers the slot the same key used last", async () => {
  const slots = new PreviewSlots({ range, probe: async () => true, file: file() });
  const a = await slots.allocate({ key: "A" });
  slots.release(a);
  const b = await slots.allocate({ key: "B" });
  assert.notEqual(b, a);
  slots.release(b);
  assert.equal(await slots.allocate({ key: "A" }), a);
});

test("a slot whose probe fails is skipped; none left -> PREVIEW_RANGE_FULL", async () => {
  const taken = new Set([41000, 41001]);
  const slots = new PreviewSlots({
    range,
    probe: async (port) => !taken.has(port),
    file: file(),
  });
  assert.equal(await slots.allocate({ key: "A" }), 41002);
  await assert.rejects(slots.allocate({ key: "B" }), {
    code: "PREVIEW_RANGE_FULL",
    status: 409,
  });
  assert.deepEqual([...slots.busy()], [41002]);
});

test("a slot is reserved before probing so concurrent allocations never share it", async () => {
  const slots = new PreviewSlots({
    range,
    probe: () => new Promise((resolve) => setTimeout(() => resolve(true), 20)),
    file: file(),
  });
  const [x, y] = await Promise.all([
    slots.allocate({ key: "A" }),
    slots.allocate({ key: "B" }),
  ]);
  assert.notEqual(x, y);
});

test("forbidden ports are skipped", async () => {
  const slots = new PreviewSlots({
    range,
    probe: async () => true,
    file: file(),
    forbidden: () => new Set([41000, 41001]),
  });
  assert.equal(await slots.allocate({ key: "A" }), 41002);
});

test("sticky memory survives a new PreviewSlots on the same file and holds no plain key", async () => {
  const f = file();
  const first = new PreviewSlots({ range, probe: async () => true, file: f });
  const key = "/Users/me/secret-project";
  const a = await first.allocate({ key });
  first.release(a);
  const text = fs.readFileSync(f, "utf8");
  assert.ok(!text.includes("secret-project"));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  const second = new PreviewSlots({ range, probe: async () => true, file: f });
  assert.equal(await second.allocate({ key }), a);
});

test("listenerPort returns the slot", () => assert.equal(listenerPort(41000), 41000));

test("targetAddress finds a server listening only on ::1", async (t) => {
  const server = net.createServer((socket) => socket.end());
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ port: 0, host: "::1" }, () => resolve(true));
  });
  if (!listening) return t.skip("::1 is not available");
  try {
    assert.equal(await targetAddress(server.address().port), "::1");
  } finally {
    server.close();
  }
});

test("targetAddress prefers 127.0.0.1 and returns null when nothing listens", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const port = server.address().port;
  assert.equal(await targetAddress(port), "127.0.0.1");
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await targetAddress(port, { timeoutMs: 200 }), null);
});

test("forbiddenTarget refuses AgentPier's port, the range and internal ports", () => {
  const opts = {
    hostPort: 4380,
    range: { start: 47100, end: 47109 },
    internal: new Set([5555]),
  };
  for (const port of [4380, 47100, 47109, 5555, 0, 70000, 1.5])
    assert.equal(forbiddenTarget(port, opts), true, String(port));
  assert.equal(forbiddenTarget(3000, opts), false);
});

test("a probe that throws releases its reservation", async () => {
  let calls = 0;
  const slots = new PreviewSlots({
    range: { start: 41000, end: 41000 },
    probe: async () => {
      if (calls++ === 0) throw new Error("probe failed");
      return true;
    },
    file: file(),
  });
  await assert.rejects(slots.allocate({ key: "A" }), { message: "probe failed" });
  assert.equal(slots.busy().size, 0);
  assert.equal(await slots.allocate({ key: "A" }), 41000);
});

test("a failing slots file write releases its reservation", async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "slots-")), "blocked");
  fs.writeFileSync(blocker, "not a directory");
  const slots = new PreviewSlots({
    range: { start: 41000, end: 41000 },
    probe: async () => true,
    file: path.join(blocker, "slots.json"),
  });
  await assert.rejects(slots.allocate({ key: "A" }));
  assert.equal(slots.busy().size, 0);
});
