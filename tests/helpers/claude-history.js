import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

/** Isolated Claude home with one native transcript, served through ProviderHistory. */
export async function claudeHistoryFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "claude-history-"));
  const session = { id: "fixture", accountId: "one", tool: "claude", cwd: home };
  const history = new ProviderHistory({
    home,
    accounts: {
      get: () => ({ tool: "claude" }),
      environment: () => ({ HOME: home }),
    },
  });
  t.after(async () => {
    await history.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const directory = path.join(
    home,
    ".claude/projects",
    home.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "native.jsonl");
  const base = { sessionId: "native", cwd: home };
  const line = (record) => JSON.stringify({ ...base, ...record }) + "\n";
  const write = (records) => fs.writeFile(file, records.map(line).join(""));
  const append = (records) => fs.appendFile(file, records.map(line).join(""));
  const user = (uuid, content, extra = {}) => ({
    uuid,
    type: "user",
    message: { role: "user", content },
    ...extra,
  });
  const assistant = (uuid, content, extra = {}) => ({
    uuid,
    type: "assistant",
    message: { role: "assistant", content },
    ...extra,
  });
  const entry = () => history.claudePages.entries.get(session.id);
  const indexed = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const current = entry();
    await current?.pending;
    await current?.index.job;
    await new Promise((resolve) => setImmediate(resolve));
    return current;
  };
  const pages = async (state) => {
    let page = await history.readPage(session, "native", state);
    const first = page;
    let messages = page.messages;
    while (page.next) {
      page = await history.readPage(session, "native", page.next);
      messages = [...page.messages, ...messages];
    }
    return { first, messages };
  };
  return {
    home,
    session,
    history,
    file,
    write,
    append,
    user,
    assistant,
    entry,
    indexed,
    pages,
  };
}
