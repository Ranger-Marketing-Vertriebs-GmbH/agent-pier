import { setImmediate as tick } from "node:timers/promises";
import { RUN_EVENT_KINDS } from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  sessionExtrasContract,
  sessionsContract,
} from "../helpers/runtime-port-sessions-contract.js";
import { approvalsContract } from "../helpers/runtime-port-approvals-contract.js";
import { makeHermesRuntime } from "../helpers/hermes-fake-gateway.js";

// The shared port contracts (sessions with their run events, the session extras and
// approvals) against the Hermes adapter over a fake Hermes process speaking the TUI
// gateway's JSON-RPC (hermes-fake-gateway.js). One Hermes process serves one agent,
// so each contract runs on a process of the agent it names. The allowlist is a
// reported capability gap (hermes-approvals.js).
const name = "Hermes adapter";
sessionsContract(name, makeHermesRuntime("agent-1"), { kinds: RUN_EVENT_KINDS, tick });
sessionExtrasContract(name, makeHermesRuntime("ap-1"));
approvalsContract(name, makeHermesRuntime("ap-1"), { gaps: ["allowlist"] });
