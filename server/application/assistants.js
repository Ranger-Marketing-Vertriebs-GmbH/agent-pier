import path from "node:path";
import { readJSON } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";
import {
  ASSISTANT_STORAGE_UNSAFE,
  assistantStorageProblem,
  readAssistantFeature,
  writeAssistantFeature,
} from "../features/assistants/assistant-feature.js";
import { connectAssistantServices, constructAssistantGraph } from "./assistant-graph.js";
import { recoverAssistantServices } from "./assistant-recovery.js";
import { stageRuntimeInBackground } from "../features/assistants/runtime-provisioning.js";
import { assistantProblem } from "../features/assistants/assistant-validation.js";

/** Every service the assistant subsystem contributes; all are null while it is dormant. */
export const assistantServiceNames = [
  "assistantRuntime",
  "assistants",
  "assistantTeams",
  "assistantModelAccounts",
  "assistantModelLogin",
  "assistantSpeech",
  "assistantChannels",
  "assistantMemory",
  "assistantReminders",
  "assistantRoutines",
  "assistantWorkflows",
  "assistantUpdates",
  "assistantProviderSynchronization",
];

/**
 * Constructs every assistant service, then connects them in one step. A failure in
 * either phase releases what construction already opened before it is reported.
 */
export function createAssistantServices(options) {
  const created = {};
  try {
    const graph = connectAssistantServices(constructAssistantGraph(options, created));
    return Object.fromEntries(assistantServiceNames.map((name) => [name, graph[name]]));
  } catch (error) {
    // Unconnected services are not closed through AssistantService; close each one
    // directly, one after another, so no two closes share a database.
    const closers = [
      created.workflows,
      created.bridge,
      created.teams,
      created.channels || created.speech,
      created.assistants || created.store,
    ].filter(Boolean);
    let released = Promise.resolve();
    for (const service of closers)
      released = released.then(() => service.close()).catch(() => {});
    Object.defineProperty(error, "released", { value: released });
    throw error;
  }
}
export function startAssistantServices(
  { config, assistants, assistantUpdates, assistantRuntime, assistantChannels },
  { stageInBackground = stageRuntimeInBackground } = {},
) {
  if (!assistants) return;
  if (assistants.maintenance || assistantUpdates?.status().recoveryRequired) return;
  assistantChannels.start();
  if (readJSON(path.join(assistantRuntime.paths.root, "settings.json"), {}).enabled)
    assistantRuntime.start().catch(() => {});
  // After an AgentPier update, the runtime it ships is prepared without blocking start.
  stageInBackground({ dataDir: config.dataDir });
}

function failureCode(error) {
  return error?.code === ASSISTANT_STORAGE_UNSAFE ||
    [
      serverMessages.operations.unsafeDatabaseDirectory,
      serverMessages.operations.unsafeDatabaseFile,
    ].includes(error?.message)
    ? ASSISTANT_STORAGE_UNSAFE
    : "ASSISTANT_INITIALIZATION_FAILED";
}
/**
 * Owns the opt-in switch. Assistant services exist only while the feature is enabled,
 * and a construction failure is recorded as a stable code instead of stopping AgentPier.
 */
export function createAssistantFeature(services) {
  const { dataDir } = services.config;
  const initial = readAssistantFeature(dataDir);
  let enabled = initial.enabled;
  let error = initial.error;
  let listening = false;
  let recovered = false;
  let queue = Promise.resolve();
  for (const name of assistantServiceNames) services[name] = null;
  const fail = (cause) => {
    error = failureCode(cause);
    // Only the stable code is logged; storage errors can carry private paths.
    console.error(`AgentPier could not start assistants: ${error}`);
  };
  const release = async () => {
    const { assistants, assistantChannels } = services;
    recovered = false;
    for (const name of assistantServiceNames) services[name] = null;
    await assistantChannels?.close().catch(() => {});
    await assistants?.close().catch(() => {});
  };
  const create = () => {
    if (!enabled || error || services.assistants) return;
    try {
      Object.assign(services, createAssistantServices(services));
    } catch (cause) {
      fail(cause);
    }
  };
  const connect = async () => {
    if (!services.assistants || recovered) return;
    recovered = true;
    try {
      await recoverAssistantServices(services);
    } catch (cause) {
      fail(cause);
      await release();
    }
  };
  const start = () => {
    if (!listening || !services.assistants) return;
    try {
      startAssistantServices(services);
    } catch (cause) {
      fail(cause);
    }
  };
  const serialized = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const state = () => ({ enabled, error });
  create();
  return {
    get enabled() {
      return enabled;
    },
    get error() {
      return error;
    },
    state,
    connect: () => serialized(connect),
    start() {
      listening = true;
      start();
    },
    enable: () =>
      serialized(async () => {
        writeAssistantFeature(dataDir, { enabled: true });
        enabled = true;
        if (!services.assistants) {
          error = assistantStorageProblem(dataDir);
          create();
          await connect();
          start();
        }
        return state();
      }),
    disable: () =>
      serialized(async () => {
        // Interrupting a runtime update would leave it for recovery, and a provider
        // change holds the Gateway in maintenance; let either finish first.
        if (
          services.assistantUpdates?.status().busy ||
          services.assistantProviderSynchronization?.changing
        )
          throw assistantProblem("active", 409);
        writeAssistantFeature(dataDir, { enabled: false });
        enabled = false;
        await release();
        error = assistantStorageProblem(dataDir);
        return state();
      }),
    close: () => serialized(release),
  };
}
