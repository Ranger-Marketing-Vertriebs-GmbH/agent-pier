import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";

const id = "11111111-1111-4111-8111-111111111111";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-reload-context-"));
  const accounts = new AccountStore({ dataDir: path.join(dir, "data"), home: dir });
  const history = new ProviderHistory({ accounts, home: dir });
  t.after(async () => {
    await history.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const cwd = path.join(dir, "project");
  await fs.mkdir(cwd);
  const directory = path.join(
    dir,
    ".claude",
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, id + ".jsonl");
  const session = { tool: "claude", accountId: "local-claude", cwd };
  return { history, cwd, file, session };
}
const line = (record) => JSON.stringify(record) + "\n";
const assistant = (model, extra = {}) =>
  line({
    type: "assistant",
    sessionId: id,
    message: { model, usage: { input_tokens: 10 }, content: [] },
    ...extra,
  });

test("Claude reload context reads transcripts beyond the chat history limit", async (t) => {
  const { history, cwd, file, session } = await fixture(t);
  history.read = () => assert.fail("Reload must not load the complete transcript");
  const handle = await fs.open(file, "w", 0o600);
  await handle.write(
    line({ type: "user", cwd, sessionId: id, message: { content: "Start" } }),
  );
  await handle.write(assistant("claude-old-model"));
  const output = line({
    type: "user",
    sessionId: id,
    toolUseResult: { stdout: "synthetic output ä😀".repeat(50000) },
  });
  while ((await handle.stat()).size <= 70 * 1024 * 1024) await handle.write(output);
  await handle.write(assistant("claude-opus-5-5"));
  await handle.write(assistant("claude-sidechain-model", { isSidechain: true }));
  await handle.write('{"type":"assistant","partial');
  await handle.close();
  const context = await history.readReloadContext(session, id);
  assert.equal(context.observability.context.modelId, "claude-opus-5-5");
});

test("Claude reload context keeps verifying the conversation identity", async (t) => {
  const { history, cwd, file, session } = await fixture(t);
  await fs.writeFile(file, assistant("claude-opus-5-5"));
  await assert.rejects(history.readReloadContext(session, id), { status: 404 });
  await fs.writeFile(
    file,
    line({ type: "user", cwd: cwd + "-other", sessionId: id, message: {} }),
  );
  await assert.rejects(history.readReloadContext(session, id), { status: 409 });
});
