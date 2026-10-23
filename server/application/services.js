import fs from "node:fs";
import path from "node:path";
import { ArtifactService } from "../features/artifacts/artifact-service.js";
import { revokeSessionMcp } from "../features/mcp/session-capability.js";
import { SshIntegration } from "../features/ssh/ssh-integration.js";
import { SshManagement } from "../features/ssh/ssh-management.js";
import { AgencyStore } from "../features/agency/agency-store.js";
import { AgencyTemplates } from "../features/agency/agency-templates.js";
import { SharedCliProfiles } from "../features/cli-profiles/shared-profiles.js";
import { ProviderConnections } from "../features/providers/provider-connections.js";
import { ProviderAccess } from "../features/providers/provider-access.js";
import { EndpointTester } from "../features/providers/endpoint-tester.js";
import { NotificationService } from "../features/notifications/notification-service.js";
import { RequestBroker } from "../features/requests/request-broker.js";
import { Operations } from "../features/operations/operations.js";
import { ProjectMemory } from "../features/memory/project-memory.js";
import { AuditStore } from "../features/audit/audit-store.js";
import { MutationBarrier } from "./mutation-barrier.js";
import { ProjectRebind } from "./project-rebind.js";
import { MemoryIntegration } from "../features/memory/memory-integration.js";
import { ProviderCatalog } from "../features/providers/provider-catalog.js";
import { RepositoryStore } from "../features/repositories/repository-store.js";
import { GitRemotes } from "../features/repositories/git-remote.js";
import { ProviderHistory } from "../features/chat/provider-history.js";
import { ChatDelivery } from "../features/chat/chat-delivery.js";
import { ChatStore } from "../features/chat/chat-store.js";
import { ChatImages } from "../features/chat/chat-images.js";
import { ChatSync } from "../features/chat/chat-sync.js";
import { ChatAttachments } from "../features/chat/chat-attachments.js";
import { ModelController } from "../features/models/model-controller.js";
import { ExtensionsStore } from "../features/extensions/extension-store.js";
import { McpServerStore } from "../features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../features/mcp-servers/central-changes.js";
import { McpPackages } from "../features/mcp-packages/mcp-packages.js";
import { CliMcpBindings } from "../features/mcp-servers/cli-bindings.js";
import { CliOAuthStatus } from "../features/mcp-servers/cli-oauth-status.js";
import { ToolInstaller } from "../features/tools/tool-installer.js";
import { PluginStore } from "../features/plugins/plugin-store.js";
import { NativeSessionBinding } from "../features/sessions/native-session-binding.js";
import { GithubCredentials } from "../features/repositories/github-credentials.js";
import { GithubMcpTool } from "../features/tools/github-mcp-tool.js";
import { SessionActivity } from "../features/sessions/session-activity.js";
import { AgentBus } from "../features/agentbus/agent-bus.js";
import { Preferences } from "../features/settings/preferences.js";
import { McpDirectory } from "../features/mcp-directory/client.js";
import { SlashCommandService } from "../features/chat/slash-command-service.js";
import { AccountStore, detectUtilities } from "../features/accounts/account-store.js";
import { toolBinDirectories } from "../features/tools/tool-paths.js";
import { NonoSandbox } from "../features/nono/nono-launch.js";
import { SessionManager } from "../features/sessions/session-manager.js";
import { ChatEvents } from "../features/chat/chat-events.js";
import { ChatStreams } from "../features/chat/chat-streams.js";
import { ClaudeDisplayDrafts } from "../features/chat/claude-display-drafts.js";
import {
  ClaudeModBridge,
  preferModActivity,
} from "../features/claude-mod/claude-mod-bridge.js";
import { createFileServices } from "./files.js";
import { OwnerInbox } from "../features/inbox/owner-inbox.js";

import { createAssistantFeature } from "./assistants.js";

export async function createServices(config) {
  const mutationBarrier = new MutationBarrier();
  const audit = new AuditStore(config);
  const notifications = new NotificationService(config);
  let requests, agentbus, inbox;
  const providerCatalog = new ProviderCatalog({ dataDir: config.dataDir });
  const providerConnections = new ProviderConnections({
    dataDir: config.dataDir,
    providerCatalog,
  });
  const endpointTester = new EndpointTester({ connections: providerConnections });
  const accounts = new AccountStore({ ...config, providerCatalog, providerConnections });
  const preferences = new Preferences({ ...config, accounts });
  // The MCP Registry, asked only on an owner request (docs/mcp.md); memory cache only.
  const mcpDirectory = new McpDirectory({
    settings: () => preferences.get().mcpDirectory,
  });
  const providerAccess = new ProviderAccess({
    preferences,
    accounts,
    connections: providerConnections,
    providerCatalog,
  });
  const memory = new ProjectMemory(config);
  const memoryIntegration = new MemoryIntegration({ ...config, accounts, memory });
  try {
    await memoryIntegration.ready;
  } catch (error) {
    await memoryIntegration.close();
    memory.close();
    throw error;
  }
  const sshManagement = new SshManagement({
    ...config,
    barrier: mutationBarrier,
    audit,
    projectRegistry: memory,
  });
  try {
    await sshManagement.ready;
  } catch (error) {
    await sshManagement.close();
    await memoryIntegration.close();
    memory.close();
    throw error;
  }
  const sshAccesses = sshManagement.store;
  const sshSessions = sshManagement.grants;
  const sshIntegration = new SshIntegration({
    dataDir: config.dataDir,
    accounts,
    accesses: sshAccesses,
    onProject: (binding) => sshManagement.registerProject(binding),
  });
  let artifacts;
  const sessions = new SessionManager({
    onRemoving: (session) => artifacts?.retireSession(session.id),
    dataDir: config.dataDir,
    onStopped: async (session) => {
      revokeSessionMcp(config.dataDir, session.id);
      await agentbus?.revoke(session.id);
      sshSessions.discard(session.id);
      await sshIntegration.discard(session.id);
      await requests?.discard(session.id);
      if (session.memory?.enabled) await memoryIntegration.discard(session.id);
    },
  });
  await sessions.ready;
  const files = createFileServices({ config, sessions, mutationBarrier });
  const repositories = new RepositoryStore(config);
  // Each listed project's origin remote, read live from its folder.
  const gitRemotes = new GitRemotes();
  const history = new ProviderHistory({ accounts, home: config.home });
  const chatEvents = new ChatEvents();
  const bindings = new NativeSessionBinding({
    dataDir: config.dataDir,
    accounts,
    sessions,
    history,
  });
  const chat = new ChatStore({
    dataDir: config.dataDir,
    sessions,
    history,
    bindings,
    events: chatEvents,
  });
  const github = new GithubCredentials({
    dataDir: config.dataDir,
    repositories,
  });
  await github.sync();
  // Late-bound: the bridge mod's state needs the chat streams created below.
  let claudeMod = null;
  const activity = new SessionActivity({
    sessions,
    hooks: async (session) =>
      preferModActivity(
        claudeMod?.activity(session.id),
        await bindings.reportedActivity(session),
      ),
    pending: (id) => requests?.hasPending(id),
  });
  const models = new ModelController({ sessions });
  const chatAttachments = new ChatAttachments({ dataDir: config.dataDir, sessions });
  const chatImages = new ChatImages({
    sessions,
    chat,
    attachments: chatAttachments,
    home: config.home,
  });
  const chatSync = new ChatSync({ sessions, chatImages });
  const slashCommands = new SlashCommandService({ sessions, accounts });
  const chatStreams = new ChatStreams({
    sessions,
    chat,
    chatImages,
    chatEvents,
    accounts,
    config,
  });
  // Claude Code's MessageDisplay batches as live reply drafts (stream frames).
  const claudeDrafts = new ClaudeDisplayDrafts({ streams: chatStreams });
  // The bridge mod's reports (Claude Code 2.1.287+): token-level text, tool status and
  // turn activity; while it reports, the MessageDisplay drafts above stand aside.
  claudeMod = new ClaudeModBridge({
    streams: chatStreams,
    drafts: claudeDrafts,
    onActivity: (id) => chatEvents.publish(id, "native-activity"),
  });
  const sharedProfiles = new SharedCliProfiles({ accounts });
  const extensions = new ExtensionsStore({ accounts, home: config.home, sharedProfiles });
  const agency = new AgencyStore({ accounts, sharedProfiles });
  // Agency agents as templates for AgentPier agents and team members.
  const agencyTemplates = new AgencyTemplates(agency);
  const installer = new ToolInstaller(config);
  // Leftovers of an interrupted install go first; then an AgentPier update that pins
  // a newer agent browser updates an installed one.
  installer.sweepChromium();
  installer.keepChromiumCurrent();
  // The agents' GitHub MCP server follows its pinned version the same way.
  const githubMcp = new GithubMcpTool({ dataDir: config.dataDir });
  githubMcp.keepCurrent();
  const plugins = new PluginStore({ accounts, home: config.home, sharedProfiles });
  agentbus = new AgentBus({
    bindings,
    accounts,
    sessions,
    dataDir: config.dataDir,
    home: config.home,
    classifyFolder: (cwd) => memory.classifyFolder(cwd),
  });
  await agentbus.ready;
  // Detected per launch, the same way the workspace state and the installer see
  // it, so installing nono while AgentPier runs needs no restart.
  const nonoSandbox = new NonoSandbox({
    detect: () =>
      detectUtilities(
        { ...process.env, HOME: config.home },
        true,
        toolBinDirectories(config.dataDir),
      ),
  });
  const events = { current: null };
  const operationalWarnings = new Set();
  const onError = () => {
    if (!operationalWarnings.has("event-storage"))
      console.error("AgentPier could not persist or deliver an operations event.");
    operationalWarnings.add("event-storage");
  };
  // The central MCP servers exist with or without agents; a store that cannot be
  // opened leaves the list unavailable (503) instead of stopping AgentPier.
  let mcpServers = null;
  try {
    mcpServers = new McpServerStore({ dataDir: config.dataDir });
  } catch {
    console.error("AgentPier could not open the MCP server store.");
    operationalWarnings.add("mcp-servers-storage");
  }
  const mcpServerChanges =
    mcpServers &&
    new CentralMcpChanges({
      servers: mcpServers,
      agents: () => services.assistantMcpChanges,
      maintenance: () => !!services.assistants?.maintenance,
      // Every saved change is written into the bound CLIs at once.
      onSaved: async () => services.cliMcp?.reconcileAll(),
    });
  // Packaged MCP servers (docs/mcp.md); started once AgentPier listens (app.js).
  const mcpPackages =
    mcpServers &&
    new McpPackages({
      dataDir: config.dataDir,
      servers: mcpServers,
      changes: mcpServerChanges,
      extensions,
    });
  const cliMcp =
    mcpServers &&
    new CliMcpBindings({
      servers: mcpServers,
      extensions,
      home: config.home,
      dataDir: config.dataDir,
      changes: () => services.mcpServerChanges,
      // Codex's own OAuth state, read on the owner's profile (services.tools: app.js).
      // `cliOAuthRun` replaces running the CLI; test fixtures set it so that no test
      // reaches the real Codex unless it opts in.
      oauthStatus: new CliOAuthStatus({
        tools: () => services.tools?.() ?? [],
        accounts,
        ...(config.cliOAuthRun ? { run: config.cliOAuthRun } : {}),
      }),
      codexLogins: () => services.codexMcpLogins,
      agentNames: () =>
        new Map(
          (services.assistants?.store.listAssistants() || []).map((profile) => [
            profile.id,
            profile.name,
          ]),
        ),
    });
  requests = new RequestBroker({
    dataDir: config.dataDir,
    sessions,
    onEvent: (event) => {
      events.current?.emit(event);
      inbox?.changed();
    },
    // A CLI's own report reaches an open chat at once (the same debounced read the
    // file watcher triggers); the activity file stays for restarts.
    onNative: (sessionId, push) => {
      if (push.type === "activity") chatEvents.publish(sessionId, "native-activity");
      // Reply text while the CLI generates it (Codex proxy, OpenCode plugin).
      if (push.type === "stream") chatStreams.streamText(sessionId, push.runId, push);
      if (push.type === "stream-end")
        chatStreams.endStream(sessionId, push.runId, { turn: push.turn });
      if (push.type === "claude-display" && !claudeMod.active(sessionId))
        claudeDrafts.display(sessionId, push);
      if (push.type === "claude-mod") return claudeMod.receive(sessionId, push.events);
      // A Claude turn's drafts give way to its transcript when it stops, and are
      // dropped when it fails, the session ends or the next prompt starts.
      if (push.event === "Stop") claudeDrafts.stop(sessionId, push.lastAssistantMessage);
      if (["StopFailure", "SessionEnd", "UserPromptSubmit"].includes(push.event))
        claudeDrafts.end(sessionId);
      // The report reaches the push notifications without the poll's delay.
      if (push.type === "activity")
        services.operationsEvents?.nativeActivity(sessionId, push.event);
    },
    // A new launch or a stopped session: the mod reports again only once it loads.
    onLaunch: (sessionId) => claudeMod.forget(sessionId),
  });
  await requests.ready;
  const chatDelivery = new ChatDelivery({
    ...config,
    sessions,
    requests,
    models,
  });
  artifacts = new ArtifactService({
    dataDir: config.dataDir,
    sessionExists: (id) =>
      fs.existsSync(path.join(config.dataDir, "sessions", `${id}.json`)),
    onError,
    barrier: mutationBarrier,
    isRebound: (from, to) => memory.reboundTo(from) === to,
  });
  await artifacts.ready;
  const projectRebind = new ProjectRebind({
    dataDir: config.dataDir,
    memory,
    sshManagement,
    artifacts,
    sessions,
    audit,
    // Null while the agent feature is off or not constructed yet.
    assistantWorkflows: () => services.assistantWorkflows ?? null,
  });
  sshManagement.rebindProject = (input) => projectRebind.rebind(input);
  memory.rebindProject = (input) => projectRebind.rebind(input);
  const operations = new Operations({
    config,
    audit,
    withSnapshotBarrier: (fn) => mutationBarrier.snapshot(fn),
    // A running runtime update or provider change makes a host backup wait.
    assistantsBusy: () =>
      !!services.assistantUpdates?.status().busy ||
      !!services.assistantProviderSynchronization?.changing,
    doctorOptions: { serving: true },
  });
  const services = {
    artifacts,
    projectRebind,
    events,
    sshAccesses,
    sshSessions,
    sshIntegration,
    sshManagement,
    operationalWarnings,
    onError,
    requests,
    operations,
    notifications,
    config,
    audit,
    mutationBarrier,
    memory,
    memoryIntegration,
    providerCatalog,
    providerConnections,
    endpointTester,
    providerAccess,
    accounts,
    sessions,
    files,
    repositories,
    gitRemotes,
    history,
    bindings,
    chat,
    chatEvents,
    chatStreams,
    github,
    githubMcp,
    activity,
    models,
    chatImages,
    chatSync,
    slashCommands,
    chatAttachments,
    chatDelivery,
    extensions,
    mcpServers,
    mcpServerChanges,
    mcpPackages,
    cliMcp,
    sharedProfiles,
    agency,
    agencyTemplates,
    installer,
    plugins,
    agentbus,
    preferences,
    mcpDirectory,
    nonoSandbox,
  };
  // Everything waiting for the owner, read lazily (server/features/inbox/).
  services.inbox = inbox = new OwnerInbox({ services });
  // Push notifications carry the inbox count for the app badge.
  notifications.inboxCount = async () => (await inbox.summary()).counts.all;
  // Assistant services stay null until the owner opts in; failures never stop startup.
  services.assistantFeature = createAssistantFeature(services);
  // The managed agent browser stays while an agent browser runs, or while the running
  // Gateway was started with it and an agent has a browser profile there. Without
  // one, a later switch-on finds the browser gone and restarts first (web-tools-changes.js).
  installer.chromiumInUse = () => {
    const assistants = services.assistants;
    const runtime = assistants?.runtime;
    const profiles = Object.values(runtime?.webTools?.browserProfiles || {});
    const compiled =
      runtime?.client?.ready &&
      profiles.some((profile) => profile.agentId) &&
      runtime.webTools?.browserExecutable;
    return (
      !!assistants?.browsers?.running.size ||
      (typeof compiled === "string" &&
        compiled.startsWith(path.join(config.dataDir, "clis") + path.sep))
    );
  };
  return services;
}
