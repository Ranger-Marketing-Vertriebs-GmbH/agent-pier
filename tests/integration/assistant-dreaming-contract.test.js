import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deletedTranscripts,
  deleteNativeSession,
} from "../../server/features/assistants/chat-removal.js";
import { dreamingSection } from "../../server/features/assistants/openclaw-config/dreaming.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import {
  changed,
  dreamingKey,
  dreamingOn,
  installed,
  nativeFixture,
  snapshot,
} from "../helpers/assistant-dreaming-fixture.js";

const markers = ["DREAMORCHID", "DREAMFERN", "DREAMFORGETFUL"];
const text = (request) => JSON.stringify(request.messages ?? request.input ?? request);

test(
  "enabled dreaming sweeps each agent's own chats into its own memory only",
  { skip: !installed, timeout: contractTimeout(420000) },
  async (t) => {
    const f = await nativeFixture(t);
    const orchid = await f.create(
      "Orchid",
      { memory: true, reminders: false },
      "orchid-model",
    );
    const fern = await f.create("Fern", { memory: true, reminders: false }, "fern-model");
    const forgetful = await f.create("Forgetful", { memory: false, reminders: false });
    assert.deepEqual(
      await f.dreamingJobs(),
      [],
      "the compiled default schedules no sweep",
    );
    await f.turn(orchid, "I water the orchids every Sunday DREAMORCHID.");
    await f.turn(fern, "I water the ferns every Monday DREAMFERN.");
    await f.turn(forgetful, "I water the cacti every Friday DREAMFORGETFUL.");
    const agents = { DREAMORCHID: orchid, DREAMFERN: fern, DREAMFORGETFUL: forgetful };
    const before = Object.fromEntries(
      Object.entries(agents).map(([m, a]) => [m, snapshot(f.workspace(a))]),
    );
    const rootBefore = snapshot(f.runtime.paths.workspaces);
    const sessionsBefore = {};
    for (const [m, a] of Object.entries(agents)) sessionsBefore[m] = await f.sessions(a);

    await f.dreaming(dreamingOn);
    const job = await f.job();
    assert.equal(job.declarationKey, dreamingKey);
    assert.equal(job.schedule.expr, "0 3 * * *");
    t.diagnostic(`dreaming job: ${JSON.stringify(job)}`);
    const offset = f.model.requests.length;
    const run = await f.forceRun(job.id);
    assert.equal(run.status, "ok", JSON.stringify(run));
    await f.settle({ files: Object.values(agents).map(f.diary) });
    const requests = f.model.requests.slice(offset);
    t.diagnostic(`run: ${JSON.stringify(run)}`);
    t.diagnostic(
      `sweep model calls: ${JSON.stringify(
        requests.map((r) => ({
          model: r.model,
          markers: markers.filter((m) => text(r).includes(m)),
          system: text(r).slice(0, 200),
        })),
      )}`,
    );

    for (const [marker, agent] of Object.entries(agents)) {
      const corpus = f.corpus(agent);
      assert.match(corpus, new RegExp(marker), `${agent.name} dreams over its own chat`);
      const written = changed(before[marker], snapshot(f.workspace(agent)));
      t.diagnostic(`${agent.name} wrote: ${JSON.stringify(Object.keys(written))}`);
      for (const [name, content] of Object.entries(written)) {
        for (const other of markers.filter((m) => m !== marker))
          assert.equal(content.includes(other), false, `${name} holds ${other}`);
        t.diagnostic(`${agent.name} ${name}:\n${content.slice(0, 1500)}`);
      }
      t.diagnostic(
        `${agent.name} MEMORY.md before=${JSON.stringify(before[marker]["MEMORY.md"] ?? null)} after=${JSON.stringify(snapshot(f.workspace(agent))["MEMORY.md"] ?? null)}`,
      );
      const after = await f.sessions(agent);
      t.diagnostic(
        `${agent.name} sessions before=${sessionsBefore[marker].length} after=${after.length}: ${JSON.stringify(after.map((s) => s.key))}`,
      );
    }
    for (const request of requests) {
      const found = markers.filter((m) => text(request).includes(m));
      assert.ok(found.length <= 1, `one agent per dreaming call: ${found}`);
      if (found.length)
        assert.equal(
          request.model,
          agents[found[0]].model.modelId,
          `${found[0]}'s dreaming runs on its own model`,
        );
    }
    // Deep promotion needs repeated recalls; with its thresholds at zero (observation
    // only, not what AgentPier compiles) one more run shows how deep writes MEMORY.md.
    // Raw chat turns are refused there ("contamination"); a daily note is promoted.
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format();
    fs.writeFileSync(
      path.join(f.workspace(orchid), "memory", `${day}.md`),
      "# Notes\n\n- Orchid fertiliser goes on every second Sunday DREAMORCHID note.\n",
    );
    const beforeDeep = Object.fromEntries(
      Object.entries(agents).map(([m, a]) => [m, snapshot(f.workspace(a))]),
    );
    await f.dreaming({
      ...dreamingOn,
      phases: { deep: { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 } },
    });
    const deepOffset = f.model.requests.length;
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle();
    for (const [marker, agent] of Object.entries(agents)) {
      const written = changed(beforeDeep[marker], snapshot(f.workspace(agent)));
      t.diagnostic(
        `${agent.name} deep run wrote: ${JSON.stringify(Object.keys(written))}`,
      );
      for (const [name, content] of Object.entries(written)) {
        for (const other of markers.filter((m) => m !== marker))
          assert.equal(content.includes(other), false, `${name} holds ${other}`);
        if (name === "MEMORY.md" || name.includes("deep"))
          t.diagnostic(`${agent.name} ${name} after deep:\n${content.slice(0, 1500)}`);
      }
    }
    const promoted = snapshot(f.workspace(orchid))["MEMORY.md"];
    assert.match(
      promoted,
      /<!-- openclaw-memory-promotion:[^>]+-->\n- Notes: .*DREAMORCHID note/,
    );
    assert.doesNotMatch(
      promoted,
      /User:|Assistant:/,
      "no raw chat turn reaches MEMORY.md",
    );
    for (const request of f.model.requests.slice(deepOffset)) {
      const found = markers.filter((m) => text(request).includes(m));
      assert.ok(found.length <= 1, `one agent per dreaming call: ${found}`);
      if (found.length) assert.equal(request.model, agents[found[0]].model.modelId);
    }
    t.diagnostic(
      `deep run model calls: ${JSON.stringify(f.model.requests.slice(deepOffset).map((r) => [r.model, markers.filter((m) => text(r).includes(m))]))}`,
    );
    const root = changed(rootBefore, snapshot(f.runtime.paths.workspaces));
    t.diagnostic(`all written under workspaces: ${JSON.stringify(Object.keys(root))}`);
  },
);

test(
  "a dreaming run rewrites ingestion state wholesale; a deleted or forgotten chat stays out",
  { skip: !installed, timeout: contractTimeout(420000) },
  async (t) => {
    const f = await nativeFixture(t);
    const orchid = await f.create(
      "Orchid",
      { memory: true, reminders: false },
      "orchid-model",
    );
    const keep = await f.turn(orchid, "My balcony faces south DREAMKEEP.");
    const gone = await f.turn(orchid, "My old phone number was 555 DREAMGONE.");
    const retain = await f.turn(orchid, "My cat sleeps on the radiator DREAMRETAIN.");
    const id = async (key) =>
      (await f.call("sessions.describe", { key })).session.sessionId;
    const ids = { keep: await id(keep), gone: await id(gone), retain: await id(retain) };
    await f.dreaming(dreamingOn);
    const job = await f.job();
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle({ files: [f.diary(orchid)] });
    const first = f.ingestion(orchid);
    t.diagnostic(`ingestion state after run 1: ${JSON.stringify(first)}`);
    for (const sessionId of Object.values(ids))
      assert.ok(first.files.some((k) => k.endsWith(`/${sessionId}`)));
    const corpusDir = path.join(
      f.workspace(orchid),
      "memory",
      ".dreams",
      "session-corpus",
    );
    t.diagnostic(`corpus files: ${JSON.stringify(fs.readdirSync(corpusDir))}`);

    // 1. Removed by hand while the transcript remains: the next run reads the state
    // at its start and writes it back whole at its end, so the chat is re-ingested.
    // A short-lived handle on the live Gateway's databases, closed on every path.
    const withDb = (file, options, use) => {
      const db = new DatabaseSync(file, options);
      try {
        return use(db);
      } finally {
        db.close();
      }
    };
    const drop = (sessionId) =>
      withDb(path.join(f.runtime.paths.state, "state", "openclaw.sqlite"), {}, (db) =>
        db
          .prepare(
            "DELETE FROM plugin_state_entries WHERE plugin_id='memory-core' AND namespace LIKE 'dreaming-session-ingestion-%' AND value_json LIKE ?",
          )
          .run(`%/${sessionId}%`),
      ).changes;
    const strip = (marker) => {
      for (const name of fs.readdirSync(corpusDir)) {
        const file = path.join(corpusDir, name);
        const lines = fs.readFileSync(file, "utf8").split("\n");
        const at = lines.findIndex((l) => l.includes(marker));
        const sessionPath = at < 0 ? null : lines[at].slice(1, lines[at].indexOf("#L"));
        fs.writeFileSync(
          file,
          lines
            .filter((l) => !sessionPath || !l.startsWith(`[${sessionPath}#`))
            .join("\n"),
        );
      }
    };
    t.diagnostic(`dropped state rows for the retained chat: ${drop(ids.retain)}`);
    strip("DREAMRETAIN");
    assert.doesNotMatch(f.corpus(orchid), /DREAMRETAIN/);

    // 2. Deleted as AgentPier deletes a chat (chat-removal.js deleteNativeSession).
    await f.call("sessions.delete", { key: gone, deleteTranscript: true });
    for (const file of deletedTranscripts(
      f.runtime.paths.state,
      orchid.runtimeAgentId,
      ids.gone,
    ))
      fs.rmSync(file, { force: true });
    await f.turn(orchid, "My balcony now has tomatoes DREAMKEEPTWO.");
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle();
    const second = f.ingestion(orchid);
    t.diagnostic(`ingestion state after run 2: ${JSON.stringify(second)}`);
    const corpus = f.corpus(orchid);
    assert.match(corpus, /DREAMKEEPTWO/);
    const retained = /DREAMRETAIN/.test(corpus);
    const retainedKey = second.files.some((k) => k.endsWith(`/${ids.retain}`));
    assert.deepEqual(
      [retained, retainedKey],
      [true, true],
      "a hand removal does not survive while the transcript remains",
    );
    // The run drops the files entry of a chat whose transcript is gone, but keeps
    // its corpus lines and its seen-message hashes.
    const goneKey = second.files.some((k) => k.endsWith(`/${ids.gone}`));
    const goneSeen = second.seen.some((k) => k.includes(`/${ids.gone}`));
    assert.deepEqual([/DREAMGONE/.test(corpus), goneKey, goneSeen], [true, false, true]);
    const archived = withDb(
      path.join(
        f.runtime.paths.state,
        "agents",
        orchid.runtimeAgentId,
        "agent",
        "openclaw-agent.sqlite",
      ),
      { readOnly: true },
      (db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM session_transcript_archives WHERE session_id=?",
          )
          .get(ids.gone).n,
    );
    t.diagnostic(
      `archived transcript rows of the deleted chat in openclaw-agent.sqlite: ${archived}`,
    );

    // 3. memory-core's own deletion of a chat's derived artifacts.
    const forgot = JSON.parse(
      await f.cli([
        "memory",
        "forget",
        "--agent",
        orchid.runtimeAgentId,
        "--session",
        ids.gone,
        "--json",
      ]),
    );
    t.diagnostic(
      `openclaw memory forget --session <deleted chat>: ${JSON.stringify(forgot)}`,
    );
    assert.deepEqual(forgot.refusals, []);
    const hasGone = () => {
      const state = f.ingestion(orchid);
      return [
        /DREAMGONE/.test(f.corpus(orchid)),
        [...state.files, ...state.seen].some((k) => k.includes(`/${ids.gone}`)),
      ];
    };
    assert.deepEqual(hasGone(), [false, false], "forget removes corpus lines and state");
    await f.turn(orchid, "Tomatoes need water daily DREAMKEEPTHREE.");
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle();
    assert.match(f.corpus(orchid), /DREAMKEEPTHREE/);
    assert.deepEqual(
      hasGone(),
      [false, false],
      "a forgotten chat stays out of later runs",
    );
  },
);

test(
  "an hour change applies live during a turn, and a deleted chat leaves dreaming",
  { skip: !installed, timeout: contractTimeout(420000) },
  async (t) => {
    const f = await nativeFixture(t);
    const memory = { memory: true, reminders: false };
    const orchid = await f.create("Orchid", memory, "orchid-model");
    const fern = await f.create("Fern", memory, "fern-model");
    const chat = await f.turn(orchid, "I water the orchids every Sunday DREAMORCHID.");
    await f.turn(fern, "I water the ferns every Monday DREAMFERN.");
    await f.dreaming(dreamingOn);
    await f.job();

    // The hour change as DreamingService applies it, while a turn waits on its model
    // longer than the client's 10 s call timeout. OpenClaw writes the change at once
    // but answers config.patch only once it applied it, which waits for the running
    // turn: the call times out (DreamingService marks the change pending), config.get
    // already holds the new section (so DreamingService.converge clears it without a
    // second patch), and the job moves once the turn has ended. The turn is neither
    // interrupted nor is the Gateway restarted.
    let slowSeen = false;
    f.model.reply = (request) => {
      if (JSON.stringify(request.messages).includes("DREAMSLOW")) {
        slowSeen = true;
        return { text: "Slow reply.", delayMs: 20000 };
      }
      return { text: "A useful assistant reply." };
    };
    const { child, client, generation } = f.runtime;
    const runId = await f.send(await f.open(fern), "Think slowly DREAMSLOW.");
    await f.until(() => slowSeen, 30000, "the slow turn's model call");
    const next = { enabled: true, hour: 4, timeZone: "Europe/Berlin" };
    await assert.rejects(
      patchConfig(client, () => ({
        patch: {
          plugins: {
            entries: { "memory-core": { config: { dreaming: dreamingSection(next) } } },
          },
        },
        replacePaths: ["plugins.entries.memory-core.config.dreaming"],
      })),
      { code: "TIMEOUT" },
      "config.patch answers only after the running turn",
    );
    const written = (await client.call("config.get", {})).config;
    assert.deepEqual(
      written.plugins.entries["memory-core"].config.dreaming,
      dreamingSection(next),
      "the change is written before it is applied",
    );
    const moved = await f.until(
      async () => {
        const jobs = await f.dreamingJobs();
        return jobs.length === 1 && jobs[0].schedule.expr === "0 4 * * *" && jobs[0];
      },
      30000,
      "the job at the new hour",
    );
    // What DreamingService.converge compares with: the section exactly as patched.
    const live = (await client.call("config.get", {})).config;
    assert.deepEqual(
      live.plugins.entries["memory-core"].config.dreaming,
      dreamingSection(next),
    );
    const done = await f.wait(runId);
    assert.equal(done.status, "ok", JSON.stringify(done));
    assert.equal(f.runtime.child, child, "the Gateway process was not replaced");
    assert.equal(f.runtime.client, client, "the Gateway connection was not replaced");
    assert.equal(f.runtime.generation, generation);
    assert.equal(client.ready, true);
    t.diagnostic(`live hour change: pid=${child.pid} job=${JSON.stringify(moved)}`);

    assert.equal((await f.forceRun(moved.id)).status, "ok");
    await f.settle({ files: [f.diary(orchid), f.diary(fern)] });
    assert.match(f.corpus(orchid), /DREAMORCHID/);
    assert.match(f.corpus(fern), /DREAMFERN/);

    // Deleted as AgentPier deletes a chat: the session, its archive, then dreaming.
    const assistants = {
      runtime: f.runtime,
      store: f.store,
      ledger: { forgetTexts() {} },
    };
    const conversation = f.store.saveConversation({
      assistantId: orchid.id,
      runtimeSessionKey: chat,
    });
    assert.equal(await deleteNativeSession(assistants, conversation), true);
    await assistants.dreamingForgets;
    assert.doesNotMatch(f.corpus(orchid), /DREAMORCHID/);
    assert.match(f.corpus(fern), /DREAMFERN/, "another agent's corpus stays");
    await f.turn(orchid, "Tomatoes need water daily DREAMORCHIDTWO.");
    assert.equal((await f.forceRun(moved.id)).status, "ok");
    await f.settle();
    assert.match(f.corpus(orchid), /DREAMORCHIDTWO/);
    assert.doesNotMatch(
      f.corpus(orchid).replaceAll("DREAMORCHIDTWO", ""),
      /DREAMORCHID/,
      "the deleted chat stays out of later runs",
    );
    assert.match(f.corpus(fern), /DREAMFERN/);
  },
);
