import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareAccountTransfer } from "../../server/application/session-account-transfer.js";
import { fingerprint } from "../../server/application/session-transfer-files.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

const root = process.argv[2];
const id = "11111111-1111-4111-8111-111111111111";
const relative = `sessions/2026/09/09/rollout-${id}.jsonl`;
const source = path.join(root, "source", relative);
const target = path.join(root, "target", relative);
const session = { id: "fixture", tool: "codex", accountId: "source", cwd: root };
const accounts = {
  get: (id) => ({ id, tool: "codex" }),
  environment: (id) => ({ HOME: root, CODEX_HOME: path.join(root, id) }),
};
const history = new ProviderHistory({ accounts, home: root });
history.codex = (session) => ({
  request: async (method, params) => {
    assert.equal(method, "thread/read");
    assert.equal(params.includeTurns, false);
    return {
      thread: {
        id,
        cwd: root,
        path: path.join(root, session.accountId, relative),
        historyMode: "paginated",
      },
    };
  },
});
history.read = () => assert.fail("Reload must not load complete turn bodies");
await fs.mkdir(path.dirname(source), { recursive: true });
const handle = await fs.open(source, "w", 0o600);
let ordinal = 0;
const record = (type, payload) =>
  JSON.stringify({ ordinal: ordinal++, type, payload }) + "\n";
await handle.write(record("session_meta", { id, cwd: root, history_mode: "paginated" }));
const text = "synthetic output ä😀".repeat(50000);
for (let n = 0; n < 270; n++)
  await handle.write(
    record("response_item", { type: "function_call_output", output: text }),
  );
await handle.write(record("turn_context", { model: "gpt-6-astra" }));
await handle.close();
assert.ok((await fs.stat(source)).size > 256 * 1024 * 1024);
const context = await history.readReloadContext(session, id);
assert.equal(context.observability.context.modelId, "gpt-6-astra");
const transfer = await prepareAccountTransfer(
  { accounts, history },
  session,
  { id: "target" },
  id,
);
await assert.rejects(fs.access(target));
await fs.appendFile(
  source,
  record("event_msg", { text: "Final append after preflight" }),
);
await transfer.commit();
assert.equal((await fingerprint(source)).hash, (await fingerprint(target)).hash);
assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
await fs.appendFile(target, record("event_msg", { text: "Continue in second account" }));
await (
  await prepareAccountTransfer(
    { accounts, history },
    { ...session, accountId: "target" },
    { id: "source" },
    id,
  )
).commit();
assert.equal((await fingerprint(source)).hash, (await fingerprint(target)).hash);
await fs.appendFile(source, record("event_msg", { text: "Divergent local history" }));
await fs.appendFile(target, record("event_msg", { text: "Divergent target history" }));
await assert.rejects(
  prepareAccountTransfer({ accounts, history }, session, { id: "target" }, id),
  /different|abweichend|anderen/,
);
await history.close();
console.log("large transfer verified");
