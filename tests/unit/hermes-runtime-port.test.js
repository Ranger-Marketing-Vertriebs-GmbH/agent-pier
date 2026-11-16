import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { RUN_EVENT_KINDS } from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  sessionExtrasContract,
  sessionsContract,
} from "../helpers/runtime-port-sessions-contract.js";
import { approvalsContract } from "../helpers/runtime-port-approvals-contract.js";
import { routinesContract } from "../helpers/runtime-port-routines-contract.js";
import { memoryContract } from "../helpers/runtime-port-memory-contract.js";
import { makeHermesRuntime } from "../helpers/hermes-fake-gateway.js";
import { hermesAgentFiles } from "../../server/features/assistants/runtimes/hermes/hermes-files.js";
import { memoryFor } from "../../server/features/assistants/runtimes/runtime-for.js";

// The shared port contracts (sessions with their run events, the session extras,
// approvals and routines) against the Hermes adapter over a fake Hermes process speaking the TUI
// gateway's JSON-RPC (hermes-fake-gateway.js). One Hermes process serves one agent,
// so each contract runs on a process of the agent it names. The allowlist is a
// reported capability gap (hermes-approvals.js).
const name = "Hermes adapter";
sessionsContract(name, makeHermesRuntime("agent-1"), { kinds: RUN_EVENT_KINDS, tick });
sessionExtrasContract(name, makeHermesRuntime("ap-1"));
approvalsContract(name, makeHermesRuntime("ap-1"), { gaps: ["allowlist"] });
// One process set serves one agent: a routine of another is refused.
routinesContract(name, makeHermesRuntime("ap-1"), { singleAgent: true });

// Its memory format is the one memoryFor answers without a host, in every view. It
// is pure, so the agentFiles sub-port needs no running set for it.
const agentFiles = () => hermesAgentFiles({ client: null });
memoryContract(name, async () => ({ memory: agentFiles().memory }));
test(`${name}: agentFiles.memory is the format memoryFor answers`, async () => {
  const runtime = await makeHermesRuntime("ap-1")({});
  const memory = memoryFor({ runtime: runtime.id });
  assert.equal(agentFiles().memory, memory);
  assert.equal(agentFiles().on(null).memory, memory);
});
