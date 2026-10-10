import { NativeRoutines } from "../features/assistants/native-routines.js";
import { temporaryMember } from "../features/assistants/team-presentation.js";
import { TeamService } from "../features/assistants/team-service.js";
import { NativeMemory } from "../features/assistants/native-memory.js";
import { NativeReminders } from "../features/assistants/native-reminders.js";
import { TeamBridge } from "../features/assistants/team-bridge.js";
import { ChannelService } from "../features/assistant-channels/channel-service.js";
import { SpeechConnections } from "../features/speech/speech-connections.js";
import { AssistantModelAccounts } from "../features/assistants/model-accounts.js";
import { AssistantAccountLogin } from "../features/assistants/model-account-login.js";
import { AssistantStore } from "../features/assistants/assistant-store.js";
import { AssistantModels } from "../features/assistants/assistant-models.js";
import { AssistantConfig } from "../features/assistants/assistant-config.js";
import { AssistantService } from "../features/assistants/assistant-service.js";
import { RuntimeSupervisor } from "../features/assistants/runtime-supervisor.js";
import {
  AssistantMaintenance,
  needsAssistantMaintenance,
} from "../features/assistants/assistant-maintenance.js";
import { AssistantWorkflows } from "../features/assistants/assistant-workflows.js";
import { RuntimeUpdates } from "../features/assistants/runtime-updates.js";
import { AssistantProviderSynchronization } from "../features/assistants/assistant-provider-synchronization.js";
import {
  expectWiring,
  requireReferences,
  wire,
} from "../features/assistants/service-wiring.js";

/**
 * Phase one: constructs every assistant service. Back-references between services
 * are not assigned here; marked services refuse to run until the connect step.
 * `created` records what was opened so a failed construction can release it.
 */
export function constructAssistantGraph(host, created = {}) {
  const { config, providerConnections, audit } = host;
  const { dataDir } = config;
  const assistantRuntime = expectWiring(
    new RuntimeSupervisor({ dataDir }),
    "assistantRuntime",
    ["teamConfiguration", "maintenance", "beforeSpawn", "afterReady"],
  );
  const store = (created.store = new AssistantStore({ dataDir }));
  const assistantModelAccounts = new AssistantModelAccounts({
    dataDir,
    runtime: assistantRuntime,
  });
  const assistantModelLogin = new AssistantAccountLogin({
    runtime: assistantRuntime,
    accounts: assistantModelAccounts,
  });
  const models = new AssistantModels({
    connections: providerConnections,
    accounts: assistantModelAccounts,
  });
  const client = { call: (...args) => assistantRuntime.client.call(...args) };
  const configuration = expectWiring(
    new AssistantConfig({
      client,
      models,
      store,
      workspaces: assistantRuntime.paths.workspaces,
    }),
    "configuration",
    ["teamReady", "writeGuard", "hostCapacity", "nativeReady"],
  );
  const assistants = (created.assistants = expectWiring(
    new AssistantService({
      store,
      models,
      runtime: assistantRuntime,
      config: configuration,
      login: assistantModelLogin,
      accounts: assistantModelAccounts,
    }),
    "assistants",
    ["teams", "reminders", "routines", "workflows", "providerSynchronization"],
  ));
  // Initial state, not a reference: an interrupted update or maintenance persists.
  assistants.maintenance = needsAssistantMaintenance(assistantRuntime.paths);
  const assistantTeams = (created.teams = expectWiring(
    new TeamService({ assistants, config: configuration, audit }),
    "assistantTeams",
    ["bridge"],
  ));
  const bridge = (created.bridge = new TeamBridge({
    assistants,
    teams: assistantTeams,
    generation: () => assistantRuntime.generation,
  }));
  const assistantSpeech = (created.speech = new SpeechConnections({ dataDir }));
  const assistantChannels = (created.channels = new ChannelService({
    dataDir,
    assistants,
    speech: assistantSpeech,
  }));
  const assistantMemory = new NativeMemory(assistants, {
    workspaces: assistantRuntime.paths.workspaces,
  });
  const assistantReminders = new NativeReminders({
    assistants,
    channels: assistantChannels,
    dataDir,
  });
  const assistantRoutines = new NativeRoutines({ reminders: assistantReminders });
  // The workflow layer looks services up by name: assistant services from this graph,
  // everything else (sessions, projects, configuration) from the application.
  const scope = Object.assign(Object.create(host), {
    assistantRuntime,
    assistants,
    assistantTeams,
    assistantModelAccounts,
    assistantModelLogin,
    assistantSpeech,
    assistantChannels,
    assistantMemory,
    assistantReminders,
    assistantRoutines,
  });
  // Its timer starts after recovery (see recoverAssistantServices).
  const assistantWorkflows = (created.workflows = new AssistantWorkflows({
    services: scope,
    autoStart: false,
  }));
  const maintenance = new AssistantMaintenance(scope);
  const assistantUpdates = new RuntimeUpdates({
    dataDir,
    runtime: assistantRuntime,
    maintenance,
    isBlocked: () => !!scope.assistantProviderSynchronization?.changing,
    affected: () => {
      const profiles = store.listAssistants();
      const members = profiles.filter(temporaryMember).length;
      return { agents: profiles.length - members, teamMembers: members };
    },
  });
  const assistantProviderSynchronization = new AssistantProviderSynchronization({
    assistants,
    connections: providerConnections,
    maintenance,
    isUpdating: () => scope.assistantUpdates.status().busy,
  });
  Object.assign(scope, {
    assistantWorkflows,
    assistantUpdates,
    assistantProviderSynchronization,
  });
  return {
    ...scope,
    store,
    configuration,
    bridge,
    maintenance,
  };
}

const graphMembers = [
  "assistantRuntime",
  "assistants",
  "assistantTeams",
  "assistantReminders",
  "assistantRoutines",
  "assistantWorkflows",
  "assistantProviderSynchronization",
  "store",
  "configuration",
  "bridge",
];

/**
 * Phase two: the only place assistant services receive references to each other.
 * It returns only after every marked service is connected and otherwise throws an
 * ASSISTANT_WIRING_INCOMPLETE error naming what is missing.
 */
export function connectAssistantServices(graph) {
  requireReferences(
    "assistant graph",
    Object.fromEntries(graphMembers.map((name) => [name, graph[name]])),
  );
  const {
    assistantRuntime: runtime,
    assistants,
    assistantTeams: teams,
    assistantReminders: reminders,
    assistantRoutines: routines,
    assistantWorkflows: workflows,
    assistantProviderSynchronization: synchronization,
    store,
    configuration,
    bridge,
  } = graph;
  wire(teams, "assistantTeams", { bridge });
  wire(assistants, "assistants", {
    teams,
    reminders,
    routines,
    workflows,
    providerSynchronization: synchronization,
  });
  wire(configuration, "configuration", {
    teamReady: () => bridge.status().ready,
    writeGuard: () => bridge.guardLive(),
    hostCapacity: () => teams.store.settings().hostMaxConcurrent,
    nativeReady: () => !!reminders.webhook.server?.listening,
  });
  wire(runtime, "assistantRuntime", {
    teamConfiguration: async (installed) => {
      if (!installed.teamPlugin)
        throw Object.assign(Error("Team plugin unavailable"), {
          code: "TEAM_PLUGIN_UNAVAILABLE",
        });
      return {
        directory: installed.teamPlugin.directory,
        connection: await bridge.start(),
        hostMaxConcurrent: teams.store.settings().hostMaxConcurrent,
        native: await reminders.start(),
        profiles: store.listAssistants(),
      };
    },
    maintenance: () => assistants.maintenance,
    beforeSpawn: () => synchronization.prepare(),
    afterReady: () => synchronization.pauseBlocked(),
  });
  return graph;
}
