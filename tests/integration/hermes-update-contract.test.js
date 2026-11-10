import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import {
  collectEvents,
  contractAgent,
  endsRun,
  hermesSandbox,
  hermesSkip,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { guardProcess } from "../helpers/process-guard.js";
import { readJSON } from "../../server/lib/storage.js";
import { hermesManifest } from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import { createHermesUpdates } from "../../server/features/assistants/runtimes/hermes/hermes-lifecycle.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { createHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import {
  hermesUpdateHost,
  hermesUpdateMaintenance,
} from "../../server/application/hermes-wiring.js";
import {
  hermesContractDownload,
  previousHermesManifest,
} from "../../scripts/hermes-contract-downloads.mjs";

// A real Hermes update between two pins, through AgentPier's Hermes update path
// (hermes-wiring.js: the fleet as the journal's host, its maintenance; runtime-updates.js):
// the previous release (tests/fixtures/hermes-previous-manifest.json, v0.22.4) is
// installed and selected in a disposable data directory and runs an agent with a chat;
// staging installs the pinned release beside it; a turn still running blocks the
// activation, and "Pause agents and update" stops it through Hermes; an activation
// whose validation fails restores the snapshot and runs the agent on the previous
// release again, with its home as before; the next activation commits, and the agent
// runs on the pinned release with its chat. Both installations are built from their manifests (network:
// GitHub, PyPI), like the contracts' provisioning; the fake model answers. With
// AGENTPIER_HERMES_DOWNLOAD_CACHE set (CI), the archives AgentPier downloads come from
// that folder (scripts/hermes-contract-downloads.mjs); every other install step runs.
const options = { skip: hermesSkip, timeout: contractTimeout(2400000) };
const agentId = "update-agent";
const previous = previousHermesManifest();
const download = hermesContractDownload();

// The command lines of the agent's processes, which name their installation.
function runningFrom(pids) {
  const listing = execFileSync("ps", ["-o", "command=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  return listing;
}

test(
  "Hermes contract: an update between two pins rolls back on a failed validation, then commits",
  options,
  async (t) => {
    assert.notEqual(previous.version, hermesManifest.version);
    const model = await startFakeModel();
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const dataDir = dirs.root;
    const old = await ensureHermesRuntime({ dataDir, manifest: previous, download });
    assert.equal(old.version, previous.version);
    const fleet = new HermesFleet({
      dataDir,
      available: () => true,
      readyTimeoutMs: 180000,
      callTimeoutMs: 60000,
      create: (made) =>
        createHermesRuntime({
          ...made,
          desired: () => contractAgent(made.agentId, model),
        }),
    });
    dirs.stops.push(() => fleet.close());
    const supervisor = {};
    attachHermesFleet(supervisor, fleet);
    const agent = {
      id: "a1",
      name: "Update agent",
      runtime: "hermes",
      runtimeAgentId: agentId,
    };
    // The chat's turns as AgentPier's ledger keeps them (one attempt per turn).
    const chat = { id: "chat-1", assistantId: agent.id, runtimeSessionKey: null };
    const attempts = [];
    const services = {
      assistants: {
        runtime: supervisor,
        store: {
          listAssistants: () => [agent],
          getAssistant: () => agent,
          getConversation: () => chat,
        },
        ledger: {
          pending: () => attempts.filter((a) => a.state === "running"),
          getRequest: () => ({ conversationId: chat.id }),
          getAttempt: (id) => attempts.find((a) => a.id === id),
          transition: (id, state) => (attempts.find((a) => a.id === id).state = state),
        },
        changed() {},
      },
    };
    const set = () => fleet.sets.get(agentId).supervisor;
    const guard = () => {
      for (const pid of set().pids())
        guardProcess(t, pid, { group: true, graceMs: 5000 });
    };
    await fleet.start(agent);
    guard();
    const runtime = fleet.runtimeOf(agent);
    assert.equal(runtime.host.version(), previous.version);
    assert.match(runningFrom(set().pids()), new RegExp(`/${previous.version}-py`));
    const home = set().agentPaths();

    // A chat on the previous release, with one turn.
    const label = "AgentPier update-agent chat";
    const { key } = await runtime.sessions.create({
      agentId,
      label,
      idempotencyKey: "c1",
    });
    const turn = async (text, runId) => {
      const run = collectEvents(runtime.events);
      await runtime.sessions.send({
        key,
        turn: { message: text },
        idempotencyKey: runId,
      });
      const end = await run.until(endsRun(runId));
      run.unsubscribe();
      assert.equal(end.kind, "finished");
    };
    await turn("before the update", "r1");
    chat.runtimeSessionKey = key;

    let fail = true;
    const base = hermesUpdateMaintenance(services);
    const marker = path.join(home.hermesHome, "written-during-validation");
    const maintenance = {
      ...base,
      async validate() {
        await base.validate();
        if (!fail) return;
        // Once: the rollback validates the restored release too.
        fail = false;
        // Something the new release wrote: the rollback must take it away again.
        fs.writeFileSync(marker, "x");
        throw Object.assign(Error("validation failed"), { code: "CONTRACT_INVALID" });
      },
    };
    const host = hermesUpdateHost(services);
    const updates = createHermesUpdates({
      dataDir,
      // Staging builds the pinned release through the real install; only its
      // downloads may come from the contracts' cache.
      host: { ...host, install: (o) => host.install({ ...o, download }) },
      maintenance,
    });
    // Staging installs the pinned release beside the selected one.
    await updates.stage();
    const selection = path.join(hermesPaths(dataDir).root, "runtime.json");
    const candidate = readJSON(path.join(hermesPaths(dataDir).root, "candidate.json"));
    assert.equal(candidate.version, hermesManifest.version);
    assert.equal(readJSON(selection).version, previous.version);

    // A turn still running blocks the activation; nothing changed.
    await runtime.sessions.send({
      key,
      turn: { message: "SLOW reply while the update waits" },
      idempotencyKey: "slow",
    });
    attempts.push({
      id: "t-slow",
      requestId: "q",
      state: "running",
      runtimeRunId: "slow",
    });
    await assert.rejects(updates.activate(), (e) => e.code === "UPDATE_BLOCKED");
    const { blockerItems } = updates.status();
    assert.deepEqual(
      blockerItems.map((i) => [i.code, i.kind, i.resolution, i.agent.name]),
      [["ASSISTANT_WORK", "chat_turn", "stop", "Update agent"]],
    );
    assert.equal(readJSON(selection).version, previous.version);
    assert.equal(runtime.host.ready(), true);

    // "Pause agents and update" stops it through Hermes and goes on; a failed
    // validation then restores the snapshot and the previous release.
    await assert.rejects(
      updates.activate({
        resolveBlockers: true,
        items: blockerItems.map(({ id, revision }) => ({ id, revision })),
      }),
      (e) => e.code === "UPDATE_ROLLED_BACK",
    );
    assert.equal(attempts[0].state, "cancelled");
    assert.equal(updates.status().phase, "rolled_back");
    assert.equal(readJSON(selection).version, previous.version);
    await eventually(() => runtime.host.ready(), 240000, "the rolled-back set");
    guard();
    assert.equal(runtime.host.version(), previous.version);
    assert.match(runningFrom(set().pids()), new RegExp(`/${previous.version}-py`));
    assert.equal(fs.existsSync(marker), false);
    const kept = await runtime.sessions.history({ sessionKey: key, limit: 20 });
    assert.ok(kept.messages.some((m) => m.entry.text === "ECHO: before the update"));
    // The stopped turn never finished its reply.
    assert.ok(!kept.messages.some((m) => m.entry.text.endsWith(" tick".repeat(40))));

    // The next activation commits: the agent runs on the pinned release, its chat kept.
    await updates.activate();
    assert.equal(updates.status().phase, "complete");
    assert.equal(readJSON(selection).version, hermesManifest.version);
    await eventually(() => runtime.host.ready(), 240000, "the updated set");
    guard();
    assert.equal(runtime.host.version(), hermesManifest.version);
    assert.match(runningFrom(set().pids()), new RegExp(`/${hermesManifest.version}-py`));
    await turn("after the update", "r2");
    const after = await runtime.sessions.history({ sessionKey: key, limit: 20 });
    // The stopped turn's partial reply aside, both answers are kept in order.
    assert.deepEqual(
      after.messages
        .filter(
          (m) =>
            m.entry.role === "assistant" && /^ECHO: (before|after) /.test(m.entry.text),
        )
        .map((m) => m.entry.text),
      ["ECHO: before the update", "ECHO: after the update"],
    );
    await fleet.close();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
