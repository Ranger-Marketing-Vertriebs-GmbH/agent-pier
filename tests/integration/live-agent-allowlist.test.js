import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import {
  commandHash,
  rememberedCommands,
  rememberedId,
} from "../../server/features/assistants/exec-remembered.js";

// The live `agent.allowlist:<id>` topic answers GET /api/assistants/:id/shell-allowlist
// and pushes every change: for a Hermes agent its remembered commands, readable while
// neither OpenClaw nor Hermes runs.
const timeout = 20000;
const loaded = 10000;

async function subscribe(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello", loaded);
  live.send({ op: "sub", topic });
  return { live, first: await live.next((frame) => frame.topic === topic, loaded) };
}

test(
  "a Hermes agent's allowlist topic pushes a remembered command and its deletion",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t, enabledAssistants);
    const service = f.application.assistants;
    const heron = service.store.createAssistant({
      name: "Heron",
      model: { connectionId: "c", modelId: "m" },
      runtime: "hermes",
    });
    const path = `/api/assistants/${heron.id}/shell-allowlist`;
    const topic = `agent.allowlist:${heron.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.data, { entries: [], exactOnly: true });
    assert.deepEqual(first.data, await (await f.request(path)).json());

    // As exec-decisions.js remembers an "Always allow" and announces the change.
    const command = "python3 report.py";
    rememberedCommands(service.store.db).remember(heron.id, {
      hash: commandHash(command),
      command,
      cwd: "/work",
    });
    service.changed({ feeds: false });
    const pushed = await live.next((frame) => frame.topic === topic, loaded);
    const id = rememberedId(commandHash(command));
    assert.deepEqual(
      pushed.data.entries.map((e) => [e.id, e.command]),
      [[id, command]],
    );
    assert.deepEqual(pushed.data, await (await f.request(path)).json());

    const removed = await f.request(`${path}/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const emptied = await live.next(
      (frame) => frame.topic === topic && frame.data?.entries?.length === 0,
      loaded,
    );
    assert.equal(emptied.data.exactOnly, true);
    live.ws.close();
  },
);
