import { SshAccessStore } from "../features/ssh/ssh-access-store.js";
import { SshSessions } from "../features/ssh/ssh-sessions.js";
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
import { AccountStore } from "../features/accounts/account-store.js";
import { SessionManager } from "../features/sessions/session-manager.js";

export async function createServices(config) {
  const mutationBarrier = new MutationBarrier();
  const audit = new AuditStore(config);
  const notifications = new NotificationService(config);
  let requests;
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
  const sshAccesses = new SshAccessStore(config);
  const sshSessions = new SshSessions({ dataDir: config.dataDir, store: sshAccesses });
  const sessions = new SessionManager({
    dataDir: config.dataDir,
    onStopped: async (session) => {
      sshSessions.discard(session.id);
      await requests?.discard(session.id);
      if (session.memory?.enabled) await memoryIntegration.discard(session.id);
    },
  });
  await sessions.ready;
  const repositories = new RepositoryStore(config);
  const history = new ProviderHistory({ accounts, home: config.home });
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
  });
  const github = new GithubCredentials({
    dataDir: config.dataDir,
    repositories,
  });
  await github.sync();
  const activity = new SessionActivity({ sessions });
  const models = new ModelController({ sessions });
  const chatImages = new ChatImages({ sessions, chat, home: config.home });
  const chatAttachments = new ChatAttachments({ dataDir: config.dataDir, sessions });
  const sharedProfiles = new SharedCliProfiles({ accounts });
  const extensions = new ExtensionsStore({ accounts, home: config.home, sharedProfiles });
  const agency = new AgencyStore({ accounts, sharedProfiles });
  const installer = new ToolInstaller(config);
  const plugins = new PluginStore({ accounts, home: config.home, sharedProfiles });
  const agentbus = new AgentBus({
    accounts,
    sessions,
    dataDir: config.dataDir,
    home: config.home,
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
  const chatDelivery = new ChatDelivery({ ...config, sessions, requests, models });
  const operations = new Operations({
    config,
    audit,
    withSnapshotBarrier: (fn) => mutationBarrier.snapshot(fn),
    doctorOptions: { serving: true },
  });
  return {
    events,
    sshAccesses,
    sshSessions,
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
    repositories,
    history,
    bindings,
    chat,
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
  };
}
