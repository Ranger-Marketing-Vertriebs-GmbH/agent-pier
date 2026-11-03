import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../server/lib/config.js";
import { ticketRuleTiming } from "../../server/features/tickets/rule-monitor.js";

test('10 minutes by default; 5 → 300000; 0, 1441, "5" → 600000', () => {
  assert.deepEqual(ticketRuleTiming(undefined), { intervalMs: 600_000 });
  assert.deepEqual(ticketRuleTiming({}), { intervalMs: 600_000 });
  assert.deepEqual(ticketRuleTiming({ intervalMinutes: 5 }), { intervalMs: 300_000 });
  assert.deepEqual(ticketRuleTiming({ intervalMinutes: 1 }), { intervalMs: 60_000 });
  assert.deepEqual(ticketRuleTiming({ intervalMinutes: 1440 }), {
    intervalMs: 86_400_000,
  });
  for (const intervalMinutes of [0, 1441, "5", 2.5, -1, null, Number.NaN])
    assert.deepEqual(
      ticketRuleTiming({ intervalMinutes }),
      { intervalMs: 600_000 },
      String(intervalMinutes),
    );
});

test("config.json ticketRules.intervalMinutes reaches the config", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rule-config-"));
  const saved = process.env.AGENTPIER_DATA_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.AGENTPIER_DATA_DIR;
    else process.env.AGENTPIER_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.AGENTPIER_DATA_DIR = dir;
  assert.deepEqual(loadConfig().ticketRules, { intervalMs: 600_000 });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ticketRules: { intervalMinutes: 15 } }),
  );
  assert.deepEqual(loadConfig().ticketRules, { intervalMs: 900_000 });
});
