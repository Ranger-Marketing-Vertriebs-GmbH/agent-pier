import fs from "node:fs";
import path from "node:path";
import { ArtifactService } from "../features/artifacts/artifact-service.js";
import { revokeSessionMcp } from "../features/mcp/session-capability.js";
import { SshIntegration } from "../features/ssh/ssh-integration.js";
import { SshManagement } from "../features/ssh/ssh-management.js";
import { AgencyStore } from "../features/agency/agency-store.js";
import { SharedCliProfiles } from "../features/cli-profiles/shared-profiles.js";
import { ProviderConnections } from "../features/providers/provider-connections.js";
import { ProviderAccess } from "../features/providers/provider-access.js";
import { NotificationService } from "../features/notifications/notification-service.js";
import { RequestBroker } from "../features/requests/request-broker.js";
import { Operations } from "../features/operations/operations.js";
import { ProjectMemory } from "../features/memory/project-memory.js";
import { AuditStore } from "../features/audit/audit-store.js";
import { MutationBarrier } from "./mutation-barrier.js";
import { MemoryIntegration } from "../features/memory/memory-integration.js";
import { ProviderCatalog } from "../features/providers/provider-catalog.js";
import { RepositoryStore } from "../features/repositories/repository-store.js";
import { ProviderHistory } from "../features/chat/provider-history.js";
import { ChatDelivery } from "../features/chat/chat-delivery.js";
import { ChatStore } from "../features/chat/chat-store.js";
import { ChatImages } from "../features/chat/chat-images.js";
import { ChatAttachments } from "../features/chat/chat-attachments.js";
import { ModelController } from "../features/models/model-controller.js";
import { ExtensionsStore } from "../features/extensions/extension-store.js";
import { ToolInstaller } from "../features/tools/tool-installer.js";
import { PluginStore } from "../features/plugins/plugin-store.js";
import { NativeSessionBinding } from "../features/sessions/native-session-binding.js";
import { GithubCredentials } from "../features/repositories/github-credentials.js";
import { SessionActivity } from "../features/sessions/session-activity.js";
import { AgentBus } from "../features/agentbus/agent-bus.js";
import { Preferences } from "../features/settings/preferences.js";
import { AccountStore, detectUtilities } from "../features/accounts/account-store.js";
import { toolBinDirectories } from "../features/tools/tool-paths.js";
import { NonoSandbox } from "../features/nono/nono-launch.js";
import { SessionManager } from "../features/sessions/session-manager.js";
import { ChatEvents } from "../features/chat/chat-events.js";
import { ChatStreams } from "../features/chat/chat-streams.js";
import { createFileServices } from "./files.js";

export async function createServices(config) {
  const mutationBarrier = new MutationBarrier();
  const audit = new AuditStore(config);
  const notifications = new NotificationService(config);
  let requests, agentbus;
  const providerCatalog = new ProviderCatalog({ dataDir: config.dataDir });
  const providerConnections = new ProviderConnections({
    dataDir: config.dataDir,
    providerCatalog,
  });
  const accounts = new AccountStore({ ...config, providerCatalog, providerConnections });
  const preferences = new Preferences({ ...config, accounts });
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
  const activity = new SessionActivity({ sessions });
  const models = new ModelController({ sessions });
  const chatImages = new ChatImages({ sessions, chat, home: config.home });
  const chatStreams = new ChatStreams({
    sessions,
    chat,
    chatImages,
    chatEvents,
    accounts,
    config,
  });
  const chatAttachments = new ChatAttachments({ dataDir: config.dataDir, sessions });
  const sharedProfiles = new SharedCliProfiles({ accounts });
  const extensions = new ExtensionsStore({ accounts, home: config.home, sharedProfiles });
  const agency = new AgencyStore({ accounts, sharedProfiles });
  const installer = new ToolInstaller(config);
  const plugins = new PluginStore({ accounts, home: config.home, sharedProfiles });
  agentbus = new AgentBus({
    bindings,
    accounts,
    sessions,
    dataDir: config.dataDir,
    home: config.home,
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
  requests = new RequestBroker({
    dataDir: config.dataDir,
    sessions,
    onEvent: (event) => events.current?.emit(event),
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
  });
  await artifacts.ready;
  const operations = new Operations({
    config,
    audit,
    withSnapshotBarrier: (fn) => mutationBarrier.snapshot(fn),
    doctorOptions: { serving: true },
  });
  return {
    artifacts,
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
    providerAccess,
    accounts,
    sessions,
    files,
    repositories,
    history,
    bindings,
    chat,
    chatEvents,
    chatStreams,
    github,
    activity,
    models,
    chatImages,
    chatAttachments,
    chatDelivery,
    extensions,
    sharedProfiles,
    agency,
    installer,
    plugins,
    agentbus,
    preferences,
    nonoSandbox,
  };
}
