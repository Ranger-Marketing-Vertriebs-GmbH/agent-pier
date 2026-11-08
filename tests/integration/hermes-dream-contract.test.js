import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { dreamOnce } from "../../server/features/assistants/hermes-dream.js";

// One nightly dream (hermes-dream.js) on the pinned Hermes: the agent's files through
// its agentFiles port and the agent's model through Hermes's one-shot call, with the
// in-repo fake model, whose "DREAM_REPLY: <json>" in a chat is the dream's answer.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";
const seeded =
  "📌 Owner's vault is /srv/quartz\n§\nOwner likes tea\n§\nOwner likes green tea";

async function dreamOver(t, answer) {
  const model = await startFakeModel();
  t.after(() => model.close());
  const dirs = hermesSandbox(t);
  const hermes = await startHermes(t, dirs, { agentId, model });
  const files = hermes.runtime.agentFiles;
  const before = await files.get({ agentId, name: "MEMORY.md" });
  await files.set({
    agentId,
    name: "MEMORY.md",
    content: seeded,
    ...(before.file.missing
      ? { expectedMissing: true }
      : { expectedHash: before.file.hash }),
  });
  const chats = [
    {
      channel: "web",
      messages: [
        { role: "person", text: `DREAM_REPLY: ${JSON.stringify(answer)}`, at: 1 },
      ],
    },
  ];
  const outcome = await dreamOnce({
    files,
    sessions: hermes.runtime.sessions,
    agentId,
    chats,
  });
  const memory = path.join(hermes.agent.hermesHome, "memories", "MEMORY.md");
  return { outcome, memory, model, dirs, stop: hermes.stop };
}

test(
  "Hermes contract: a dream consolidates memory and keeps a pinned entry",
  options,
  async (t) => {
    const { outcome, memory, model, dirs, stop } = await dreamOver(t, {
      "MEMORY.md": [
        { keep: "M1" },
        { text: "Owner likes green tea", from: ["M2", "M3"] },
      ],
      "USER.md": [],
      summary: "Merged tea.",
    });
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome));
    assert.equal(outcome.summary, "Merged tea.");
    assert.equal(
      fs.readFileSync(memory, "utf8"),
      "📌 Owner's vault is /srv/quartz\n§\nOwner likes green tea",
    );
    const last = model.requests.at(-1).body;
    assert.equal((last.tools || []).length, 0, "the dream offers the model no tools");
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

test(
  "Hermes contract: a dream that drops a pinned entry is discarded",
  options,
  async (t) => {
    const { outcome, memory, dirs, stop } = await dreamOver(t, {
      "MEMORY.md": [{ text: "Owner likes green tea", from: ["M2", "M3"] }],
      "USER.md": [],
      summary: "Merged tea.",
    });
    assert.equal(outcome.outcome, "discarded");
    assert.equal(outcome.reason, "pinLost");
    assert.equal(fs.readFileSync(memory, "utf8"), seeded);
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
