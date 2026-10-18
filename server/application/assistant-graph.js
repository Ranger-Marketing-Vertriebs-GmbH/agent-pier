import path from "node:path";
import { ImagePolicy } from "../features/assistants/image-policy.js";
import { NativeRoutines } from "../features/assistants/native-routines.js";
import { temporaryMember } from "../features/assistants/team-presentation.js";
import { TeamService } from "../features/assistants/team-service.js";
import { NativeMemory } from "../features/assistants/native-memory.js";
import { NativeReminders } from "../features/assistants/native-reminders.js";
import { NativeHeartbeats } from "../features/assistants/native-heartbeats.js";
import { TeamBridge } from "../features/assistants/team-bridge.js";
import { WriteGuardReapply } from "../features/assistants/write-guard-reapply.js";
import { writeGuardWiring } from "../features/assistants/write-guard-wait.js";
import { ChannelService } from "../features/assistant-channels/channel-service.js";
import { TelegramSenders } from "../features/assistant-channels/telegram-senders.js";
import { stdioAgents } from "../features/assistants/openclaw-config/telegram-senders.js";
import { WebSearchSettings } from "../features/assistants/web-search-settings.js";
import { detectBrowser } from "../features/assistants/browser-detection.js";
import { managedChromium } from "../features/tools/chromium-installer.js";
import { AgentBrowsers } from "../features/assistants/agent-browsers.js";
import { BrowserLiveView } from "../features/assistants/browser-live-view.js";
import { noteBrowserHandBack } from "../features/assistants/browser-hand-back.js";
import { webToolsAvailability } from "../features/assistants/openclaw-config/web-tools.js";
import { readMcpInputs } from "../features/assistants/openclaw-config/mcp-servers.js";
import { McpServerStore } from "../features/mcp-servers/mcp-server-store.js";
import { SpeechConnections } from "../features/speech/speech-connections.js";
import { AssistantModelAccounts } from "../features/assistants/model-accounts.js";
import { AssistantAccountLogin } from "../features/assistants/model-account-login.js";
import { AssistantStore } from "../features/assistants/assistant-store.js";
import { AssistantModels } from "../features/assistants/assistant-models.js";
import { AssistantConfig } from "../features/assistants/assistant-config.js";
import { AssistantService } from "../features/assistants/assistant-service.js";
import {
  OverrideStore,
  overridesFor,
} from "../features/assistants/openclaw-config/overrides.js";
import { RuntimeSupervisor } from "../features/assistants/runtime-supervisor.js";
import {
  AssistantMaintenance,
  needsAssistantMaintenance,
} from "../features/assistants/assistant-maintenance.js";
import { AssistantWorkflows } from "../features/assistants/assistant-workflows.js";
import { RuntimeUpdates } from "../features/assistants/runtime-updates.js";
import { AssistantProviderSynchronization } from "../features/assistants/assistant-provider-synchronization.js";
import { WebToolsChanges } from "../features/assistants/web-tools-changes.js";
import { AdvancedConfig } from "../features/assistants/advanced-config.js";
import { resolveShellOwner } from "../features/assistants/exec-shell.js";
import { McpChanges } from "../features/assistants/mcp-changes.js";
import { oauthRedirect } from "../features/mcp-servers/oauth-redirect.js";
import { McpOAuthLogins } from "../features/mcp-servers/mcp-oauth-logins.js";
import {
  supervisorMcpCli,
  sweepLogoutConfigs,
} from "../features/mcp-servers/openclaw-mcp-cli.js";
import {
  expectWiring,
  requireReferences,
  wire,
} from "../features/assistants/service-wiring.js";

// A row that can no longer apply is reported by path, never by value.
const overrideStore = (store) =>
  new OverrideStore(store.db, {
    onSkip: (path) =>
      console.warn(`Skipped invalid OpenClaw configuration override: ${path}`),
  });

/**
 * Phase one: constructs every assistant service. Back-references between services
 * are not assigned here; marked services refuse to run until the connect step.
 * `created` records what was opened so a failed construction can release it.
 */
export function constructAssistantGraph(host, created = {}) {
  const { config, providerConnections, audit } = host;
  const { dataDir } = config;
  // The managed browser AgentPier installs (Chrome for Testing) comes first.
  const detectAgentBrowser = () =>
    detectBrowser({ managed: managedChromium(path.join(dataDir, "clis"))?.executable });
  const assistantRuntime = expectWiring(
    new RuntimeSupervisor({
      dataDir,
      // Read at each launch; the store is constructed right after the supervisor.
      configOverrides: (version) => overridesFor(overrideStore(store), version),
    }),
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
    catalog: host.providerCatalog,
  });
  // The current Gateway client; a restart replaces it, so nothing binds to one.
  const client = {
    call: (...args) => assistantRuntime.client.call(...args),
    // Absent without a client that delivers events, so nothing waits for them.
    get subscribe() {
      const current = assistantRuntime.client;
      return typeof current?.subscribe === "function"
        ? (listener) => current.subscribe(listener)
        : undefined;
    },
  };
  const configuration = expectWiring(
    new AssistantConfig({
      client,
      models,
      store,
      workspaces: assistantRuntime.paths.workspaces,
    }),
    "configuration",
    [
      "teamReady",
      "writeGuard",
      "hostCapacity",
      "nativeReady",
      "webToolsAvailable",
      "shellPathPrepend",
      "mcpTools",
      "senderFacing",
      "sshGranted",
      "projectFolders",
      "github",
      "githubShellPath",
      "teamRoster",
    ],
  );
  const assistants = (created.assistants = expectWiring(
    new AssistantService({
      store,
      models,
      runtime: assistantRuntime,
      config: configuration,
      login: assistantModelLogin,
      accounts: assistantModelAccounts,
      audit,
    }),
    "assistants",
    [
      "teams",
      "reminders",
      "routines",
      "workflows",
      "providerSynchronization",
      "webTools",
      "mcp",
      "telegramSenders",
    ],
  ));
  // The agents' own browsers: profile pinning, the visible limit and idle stops.
  assistants.browsers = created.browsers = new AgentBrowsers({
    store,
    runtime: assistantRuntime,
    // An agent with a run in progress keeps its browser when another needs room;
    // an attempt whose request or chat cannot be read does not count.
    busy: (id) =>
      assistants.ledger.pending().some((attempt) => {
        try {
          return (
            store.getConversation(
              assistants.ledger.getRequest(attempt.requestId).conversationId,
            ).assistantId === id
          );
        } catch {
          return false;
        }
      }),
  });
  assistants.browsers.onChange = () => assistants.changed();
  // The owner's live view of each agent's browser (browser-live-view.js).
  assistants.liveView = new BrowserLiveView({
    browsers: assistants.browsers,
    runtime: assistantRuntime,
    // The agent continues once the owner hands its browser back.
    onHandBack: (id, reason) => noteBrowserHandBack(assistants, id, reason),
  });
  assistants.browsers.controlled = (id) => assistants.liveView.controlled(id);
  assistants.browsers.ownerControlRefused = (id) => assistants.liveView.refused(id);
  assistants.browsers.start();
  // A background model list read publishes its result like any other change.
  assistantModelAccounts.catalog.onChange = () => assistants.changed();
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
  // The timezone memory-core names the flush's day note in (memory-write-policy.js).
  bridge.flushTimeZone = () =>
    overrideStore(store).get("agents.defaults.userTimezone")?.value || undefined;
  const assistantSpeech = (created.speech = new SpeechConnections({ dataDir }));
  const assistantWebSearch = (created.webSearch = new WebSearchSettings({
    dataDir,
    connections: providerConnections,
  }));
  // The core store when AgentPier has one; it outlives the agent feature.
  const assistantMcpServers =
    host.mcpServers || (created.mcpServers = new McpServerStore({ dataDir }));
  const assistantChannels = (created.channels = new ChannelService({
    dataDir,
    assistants,
    speech: assistantSpeech,
  }));
  // A shared file also reaches the owner's Telegram chat its turn came from.
  assistants.shares.channels = assistantChannels;
  // Every image_generate call is checked and counted through the bridge.
  assistants.imagePolicy = new ImagePolicy({ assistants });
  const assistantMemory = new NativeMemory(assistants, {
    workspaces: assistantRuntime.paths.workspaces,
  });
  const assistantReminders = new NativeReminders({
    assistants,
    channels: assistantChannels,
    dataDir,
    // Each routine or reminder result sends an `agent-routine` push notice.
    notifications: host.notifications,
  });
  const assistantRoutines = new NativeRoutines({ reminders: assistantReminders });
  // Reached as assistantReminders.heartbeats: it shares the reminder webhook.
  new NativeHeartbeats({
    reminders: assistantReminders,
    notifications: host.notifications,
  });
  // The workflow layer looks services up by name: assistant services from this graph,
  // everything else (sessions, projects, configuration) from the application.
  const scope = Object.assign(Object.create(host), {
    assistantRuntime,
    assistants,
    assistantTeams,
    assistantModelAccounts,
    assistantModelLogin,
    assistantSpeech,
    assistantWebSearch,
    assistantMcpServers,
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
  // Removing an SSH host revokes agent grants and open approvals first (agent-ssh.js).
  if (host.sshManagement)
    host.sshManagement.onAccessChanged = assistantWorkflows.ssh.hook;
  const maintenance = new AssistantMaintenance(scope);
  const assistantUpdates = new RuntimeUpdates({
    dataDir,
    runtime: assistantRuntime,
    maintenance,
    isBlocked: () => !!scope.assistantProviderSynchronization?.changing,
    // MCP OAuth logins cleared since the snapshot are logged out again.
    onRolledBack: ({ createdAt }) => scope.assistantMcpOAuth?.afterRollback(createdAt),
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
  // The agents' own Telegram bots for other people; their changes restart the Gateway
  // like web tool changes do.
  const assistantTelegramSenders = new TelegramSenders({
    store: assistantChannels.nativeBots,
    assistants,
    speech: assistantSpeech,
    synchronization: assistantProviderSynchronization,
    audit,
    notifications: host.notifications,
    // Never throws: an unreadable MCP store binds no agent (its start compiles none).
    // An agent with GitHub access counts as well (agent-github.js).
    stdioAgents: () => {
      let agents = new Set();
      try {
        agents = stdioAgents({
          servers: assistantMcpServers.definitions(),
          bindings: assistantMcpServers.bindingsByTarget("agent"),
        });
      } catch {
        /* None from the store. */
      }
      for (const profile of store.listAssistants())
        if (assistantWorkflows.github.forAgent(profile)) agents.add(profile.id);
      return agents;
    },
    // Agents with SSH grants never own a bot for other people (assistant-access.js).
    sshAgents: () => assistantWorkflows.access.sshAgents(),
  });
  const assistantWebTools = new WebToolsChanges({
    assistants,
    webSearch: assistantWebSearch,
    synchronization: assistantProviderSynchronization,
    detect: detectAgentBrowser,
    // A signed-in ChatGPT account lets agents create images (model-accounts.js).
    images: () => ({ ready: assistantModelAccounts.imageReady() }),
  });
  // The owner's advanced OpenClaw settings; a restart change reuses the web tools
  // confirmation and its list of interrupted agents.
  const assistantAdvancedConfig = new AdvancedConfig({
    assistants,
    overrides: overrideStore(store),
    synchronization: assistantProviderSynchronization,
    usage: () => assistantWebTools.usage(),
    audit,
  });
  // Logout configs a killed CLI run left behind (they can name a server URL).
  sweepLogoutConfigs(assistantRuntime.paths.state);
  const assistantMcpOAuth = new McpOAuthLogins({
    cli: supervisorMcpCli(assistantRuntime),
    servers: assistantMcpServers,
    runtime: assistantRuntime,
    admit: (operation) => assistants.admit(operation),
    redirectUrl: () => oauthRedirect(host.effectiveConfig?.() || config),
    // Called under admission by a login start; assistantMcpChanges is built below.
    reapply: () => assistantMcpChanges.apply(),
    onFreed: () => assistants.admit(() => assistantMcpChanges.apply()),
    remoteUrl: () => (host.effectiveConfig?.() || config).remoteUrl,
  });
  const assistantMcpChanges = new McpChanges({
    assistants,
    servers: assistantMcpServers,
    // Read at each compile: the listener port is known only after listen.
    redirectUrl: () => oauthRedirect(host.effectiveConfig?.() || config),
    oauth: assistantMcpOAuth,
  });
  Object.assign(scope, {
    assistantWorkflows,
    assistantUpdates,
    assistantProviderSynchronization,
    assistantWebTools,
    assistantAdvancedConfig,
    assistantMcpChanges,
    assistantMcpOAuth,
    assistantTelegramSenders,
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
  "assistantWebSearch",
  "assistantMcpServers",
  "assistants",
  "assistantTeams",
  "assistantReminders",
  "assistantRoutines",
  "assistantWorkflows",
  "assistantProviderSynchronization",
  "assistantWebTools",
  "assistantMcpChanges",
  "assistantMcpOAuth",
  "assistantTelegramSenders",
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
    assistantWebSearch: webSearch,
    assistantMcpServers: mcpServers,
    assistantWebTools: webToolsChanges,
    assistantMcpChanges: mcpChanges,
    assistantTelegramSenders: telegramSenders,
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
    webTools: webToolsChanges,
    mcp: mcpChanges,
    telegramSenders,
  });
  // Refuses stdio bindings for agents with their own Telegram bot (mcp-changes.js).
  mcpChanges.telegramSenders = telegramSenders;
  // Resolved at most once per process for applies before the first ready start.
  let fallbackOwner;
  wire(configuration, "configuration", {
    teamReady: () => bridge.status().ready,
    writeGuard: () => bridge.guardLive(),
    ...writeGuardWiring({
      bridge,
      nativeReady: () => !!reminders.webhook.server?.listening,
    }),
    hostCapacity: () => teams.store.settings().hostMaxConcurrent,
    nativeReady: () => !!reminders.webhook.server?.listening,
    webToolsAvailable: () => runtime.webTools?.availability || webToolsAvailability(),
    // The PATH the running Gateway was started with; the same rule before that.
    shellPathPrepend: () =>
      runtime.shell?.pathPrepend ||
      (fallbackOwner ??= resolveShellOwner() || { pathPrepend: [] }).pathPrepend,
    // Before any start, and for agents the start did not bind, no MCP tools.
    mcpTools: (assistant) => runtime.mcp?.agentTools?.[assistant.runtimeAgentId] || [],
    // The agents whose own Telegram bot the running (or starting) Gateway compiled.
    senderFacing: (assistant) =>
      !!(runtime.telegram || runtime.telegramStarting)?.accounts.includes(
        assistant.runtimeAgentId,
      ),
    // Agents with an SSH grant get agentpier_ssh (assistant-access.js).
    sshGranted: (assistant) => workflows.access.hasSshGrants(assistant.id),
    // Project folders the agent may use directly, named in its instructions.
    projectFolders: (assistant) => workflows.folders.forAgent(assistant),
    // Its GitHub access, named in its instructions, and its shell's GitHub folder.
    github: (assistant) => workflows.github.describe(assistant),
    githubShellPath: (assistant) => workflows.github.shellPath(assistant),
    // A lead's members and team usage level, named in its instructions while its
    // team tools are offered.
    teamRoster: (assistant) =>
      bridge.status().ready ? teams.requests.roster(assistant.id) : null,
  });
  // The agents' GitHub servers compile beside the store's (agent-github.js).
  const githubInputs = (taken) =>
    workflows.github.mcpInputs(store.listAssistants(), taken);
  mcpChanges.extraInputs = githubInputs;
  // A first install or an update of the managed server reaches the agents at once.
  if (workflows.s.githubMcp)
    workflows.s.githubMcp.onReady = () =>
      assistants.admit(() => workflows.github.refresh()).catch(() => {});
  // A guard report, and leaving maintenance with a live guard, re-applies the agents
  // the Gateway start compiled without write and edit (AGENTPIER-80).
  const guardReapply = new WriteGuardReapply({
    assistants,
    live: () => bridge.guardLive(),
    generation: () => runtime.generation,
    // Their applies fail until the connection is usable again (pauseBlocked).
    blocked: (id) => synchronization.blocked.has(id),
  });
  bridge.onGuard = () => guardReapply.request();
  bridge.onGuardLost = () => guardReapply.guardLost();
  assistants.gatewayEvents.onReady(() => guardReapply.request());
  // Agents whose model connection is blocked keep no check-in job.
  reminders.heartbeats.blocked = (id) => synchronization.blocked.has(id);
  wire(runtime, "assistantRuntime", {
    teamConfiguration: async (installed) => {
      if (!installed.teamPlugin)
        throw Object.assign(Error("Team plugin unavailable"), {
          code: "TEAM_PLUGIN_UNAVAILABLE",
        });
      // Team members' MCP bindings follow their records before the start compiles
      // them, so a member that ended while the Gateway was down holds none.
      teams.mcp.sync();
      // OAuth logouts that failed earlier are retried before the start compiles
      // (the CLI needs no running Gateway).
      await mcpChanges.drainLogouts();
      return {
        directory: installed.teamPlugin.directory,
        connection: await bridge.start(),
        hostMaxConcurrent: teams.store.settings().hostMaxConcurrent,
        native: await reminders.start(),
        profiles: store.listAssistants(),
        // Eligible agents with an SSH grant (assistant-access.js sshAgents).
        sshAgents: workflows.access.sshAgents(),
        // Read at each start; secrets reach only the compiled openclaw.json.
        mcp: readMcpInputs(mcpServers, {
          redirectUrl: mcpChanges.redirectUrl(),
          extra: githubInputs,
        }),
        // Each agent's GitHub folder on its shell PATH (agent-github.js shellPaths).
        githubShell: workflows.github.shellPaths(store.listAssistants()),
        webTools: {
          search: webSearch.resolve(),
          // The same detection a save compares with (web-tools-changes.js).
          browser: webToolsChanges.detect(),
          // A runtime installed before the plugins were bundled reports none.
          searchPlugins: installed.searchPlugins || {},
          // The same readiness a save compares with (web-tools-changes.js).
          images: webToolsChanges.images(),
        },
        // Read at each start; tokens and the speech key reach only openclaw.json.
        telegram: telegramSenders.inputs(),
      };
    },
    maintenance: () => assistants.maintenance,
    beforeSpawn: () => synchronization.prepare(),
    afterReady: async () => {
      await synchronization.pauseBlocked();
      // A change made while this Gateway started, or an apply that failed before it,
      // converges now. Not awaited: a start may itself run under admission.
      mcpChanges.ready();
      // A bot or person removed while this Gateway started is removed now.
      telegramSenders.ready();
      if (mcpChanges.pending) assistants.admit(() => mcpChanges.apply()).catch(() => {});
      // Check-in jobs follow the stored settings; maintenance repeats this on leave.
      if (!assistants.maintenance) reminders.heartbeats.reconcile().catch(() => {});
      // Routine jobs follow the current run settings (tools, chat commit).
      if (!assistants.maintenance) reminders.routines?.reconcile().catch(() => {});
    },
  });
  return graph;
}
