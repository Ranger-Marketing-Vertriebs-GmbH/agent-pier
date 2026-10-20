import { stageToolchainsInBackground } from "./features/mcp-packages/toolchain-provisioning.js";
import { assistantRoutes } from "./http/routes/assistants.js";
import { agentText } from "./lib/i18n/agent-text.js";
import { messageIdentity } from "./lib/i18n/message-identity.js";
import { artifactsRoutes } from "./http/routes/artifacts.js";
import { fileTextRoutes } from "./http/routes/file-text.js";
import { SessionMcp } from "./features/mcp/session-integration.js";
import { SessionReload } from "./features/sessions/session-reload.js";
import { SessionAutoResume } from "./features/sessions/session-auto-resume.js";
import { sshRoutes } from "./http/routes/ssh.js";
import { LoginStore } from "./features/login/login-store.js";
import { UserStore } from "./features/users/user-store.js";
import { Identity } from "./features/users/identity.js";
import { OwnerPrivacy } from "./features/users/owner-privacy.js";
import { ownerContentGuard } from "./http/owner-content-guard.js";
import { loginRoutes, requireLogin } from "./http/login.js";
import { routeAccess } from "./http/route-access.js";
import { usersRoutes } from "./http/routes/users.js";
import { meAccountRoutes } from "./http/routes/me-account.js";
import { meAgentRoutes } from "./http/routes/me-agents.js";
import { meNotificationRoutes } from "./http/routes/me-notifications.js";
import { agencyRoutes } from "./http/routes/agency.js";
import { filesRoutes } from "./http/routes/files.js";
import { fileOperationsRoutes } from "./http/routes/file-operations.js";
import { fileExplorerRoutes } from "./http/routes/file-explorer.js";
import {
  fileTransferStreams,
  fileTransfersRoutes,
} from "./http/routes/file-transfers.js";
import { AccountAuthStatus } from "./features/accounts/auth-status.js";
import { createMcpServices } from "./application/mcp.js";
import {
  isMcpMachinePath,
  authorizeMcpTransport,
} from "./features/mcp/http-transport.js";
import { mcpAccessRoutes } from "./http/routes/mcp-access.js";
import { providerConnectionRoutes } from "./http/routes/provider-connections.js";
import { randomUUID } from "node:crypto";
import { OperationsEvents } from "./application/operations-events.js";
import { operationsRoutes } from "./http/routes/operations.js";
import { ReleaseSessionMigration } from "./features/operations/release-session-migration.js";
import { requestsRoutes } from "./http/routes/requests.js";
import { inboxRoutes } from "./http/routes/inbox.js";
import { notificationsRoutes } from "./http/routes/notifications.js";
import { remoteRoutes } from "./http/routes/remote.js";
import { settingsSummaryRoutes } from "./http/routes/settings-summary.js";
import { memoryRoutes } from "./http/routes/memory.js";
import { providerRoutes } from "./http/routes/providers.js";
import express from "express";
import compression from "compression";
import http from "node:http";
import { createServices } from "./application/services.js";
import { createSessionLifecycle } from "./application/session-lifecycle.js";
import { createPipelineServices } from "./application/pipelines.js";
import { cleanUpProjects } from "./application/project-cleanup.js";
import { ProjectDuplicates } from "./application/project-duplicates.js";
import { pipelineDefinitionRoutes } from "./http/routes/pipeline-definitions.js";
import { pipelineRunRoutes } from "./http/routes/pipeline-runs.js";
import { pipelineQueueRoutes } from "./http/routes/pipeline-queue.js";
import { auditHttp } from "./features/audit/audit-http.js";
import { auditRoutes } from "./http/routes/audit.js";
import { createApiRegistry } from "./http/api-registry.js";
import { healthRoutes } from "./http/routes/health.js";
import { createShutdown } from "./application/shutdown.js";
import { directoryResolver } from "./lib/directories.js";
import { detectTools } from "./features/accounts/account-store.js";
import { toolBinDirectories } from "./features/tools/tool-paths.js";
import { authorizeRequest, securityHeaders } from "./http/security.js";
import { mcpOAuthCallbackRoutes } from "./http/routes/mcp-oauth.js";
import { mcpCliOAuthCallbackRoutes } from "./http/routes/mcp-cli-oauth.js";
import { createCodexMcpLogins } from "./application/codex-mcp-logins.js";
import { mcpServerRoutes } from "./http/routes/mcp-servers.js";
import { mcpCommandRoutes } from "./http/routes/mcp-commands.js";
import { mcpDirectoryRoutes } from "./http/routes/mcp-directory.js";
import { registerResponses } from "./http/responses.js";
import { buildHeader, buildIdentity } from "./http/build-identity.js";
import { attachTerminalWebSocket } from "./http/terminal-websocket.js";
import { admitSocket } from "./http/socket-access.js";
import { UserScope } from "./features/users/user-scope.js";
import { attachChatWebSocket } from "./http/chat-websocket.js";
import { attachAssistantChatWebSocket } from "./http/assistant-chat-websocket.js";
import { attachBrowserWebSocket } from "./http/browser-websocket.js";
import { attachDictationWebSocket } from "./http/dictation-websocket.js";
import { dictationRoutes } from "./http/routes/dictation.js";
import { DictationService } from "./features/speech/dictation-service.js";
import { workspaceRoutes } from "./http/routes/workspace.js";
import { accountsRoutes } from "./http/routes/accounts.js";
import { sessionsRoutes } from "./http/routes/sessions.js";
import { repositoriesRoutes } from "./http/routes/repositories.js";
import { GithubTokenMonitor } from "./features/repositories/github-token-monitor.js";
import { SystemStatus } from "./features/system-status/system-status.js";
import { systemStatusRoutes } from "./http/routes/system-status.js";
import { extensionsRoutes } from "./http/routes/extensions.js";
import { pluginsRoutes } from "./http/routes/plugins.js";
import { chatRoutes } from "./http/routes/chat.js";
import { modelsRoutes } from "./http/routes/models.js";
import { toolsRoutes } from "./http/routes/tools.js";
import { agentbusRoutes } from "./http/routes/agentbus.js";
import {
  detectNetworkAddresses,
  allowedNetworkHosts,
  networkUrls,
} from "./features/remote/network-access.js";

export async function createApplication(config) {
  const app = express();
  const server = http.createServer(app);
  const services = await createServices(config);
  services.login = new LoginStore(config);
  services.users = new UserStore({
    dataDir: config.dataDir,
    ownerName: () => services.login.ownerName(),
  });
  // What the owner may read of his users' chats, files and browsers.
  services.ownerPrivacy = new OwnerPrivacy({
    users: services.users,
    assistants: () => services.assistants,
  });
  // A changed opt-in changes the owner's list; a withdrawn one closes his views.
  services.ownerPrivacy.on("changed", () => services.assistants?.changed());
  // Owner and user sessions; every request and socket asks it for its principal.
  services.identity = new Identity({ login: services.login, users: services.users });
  // Live dictation uses the agents' central Deepgram connection while it exists.
  services.dictation = new DictationService({
    speech: () => services.assistantSpeech || null,
    audit: services.audit,
    ...(config.dictationConnect ? { connect: config.dictationConnect } : {}),
  });
  services.tools = () =>
    detectTools(
      { ...process.env, HOME: config.home },
      true,
      toolBinDirectories(config.dataDir),
    );
  services.accountAuthStatus = new AccountAuthStatus({
    accounts: services.accounts,
    tools: () => services.tools(),
    home: config.home,
  });
  services.directory = directoryResolver(config.home);
  Object.assign(services, createSessionLifecycle(services));
  services.reload = new SessionReload({ services });
  await services.reload.initialize();
  services.autoResume = new SessionAutoResume({
    services,
    enabled: () => services.preferences.get().autoResumeInterrupted,
  });
  Object.assign(services, await createPipelineServices(services));
  services.projectRebind.definitions = services.pipelineDefinitions;
  services.projectRebind.runQueue = services.pipelineQueue;
  services.projectDuplicates = new ProjectDuplicates(services);
  await services.projectDuplicates.resume();
  // A failed one-off cleanup keeps no marker, so the next start retries it.
  // The cleanup handles no credentials, so its error code or message is safe to log.
  await cleanUpProjects(services).catch((error) =>
    console.error(
      `AgentPier could not clean up the project list; it retries next start: ${error?.code || error?.message || "unknown error"}`,
    ),
  );
  services.operationsEvents = new OperationsEvents(services);
  services.events.current = services.operationsEvents;
  await services.operationsEvents.poll();
  const instanceId = randomUUID();
  const network = config.network || { enabled: false, bind: "0.0.0.0", hosts: [] };
  const detected = detectNetworkAddresses();
  // Computed once per process; configuration changes apply after a restart.
  services.networkState = {
    bind: network.enabled ? network.bind : "127.0.0.1",
    detected,
    hosts: new Set(),
    urls: [],
    computed: false,
  };
  const effective = () => {
    const port = server.address()?.port || config.port;
    if (network.enabled && !services.networkState.computed && server.address()) {
      services.networkState.hosts = allowedNetworkHosts(network, port, detected);
      services.networkState.urls = networkUrls(network, port, detected);
      services.networkState.computed = true;
    }
    return { ...config, port, network, networkHosts: services.networkState.hosts };
  };
  server.once("listening", effective);
  services.effectiveConfig = effective;
  services.instanceId = instanceId;
  Object.assign(services, createMcpServices(services, effective));
  services.codexMcpLogins = createCodexMcpLogins(services, effective);
  services.sessionMcp = new SessionMcp(services);
  await services.sessionMcp.ready;
  // Items MCP clients queued wait until their grants can be checked again.
  services.pipelineQueue.authorize = (item) => services.mcpTools.queuedStart(item);
  services.pipelineQueue.changed();
  // Runs after SessionMcp so assistant recovery can never delay it; failures stay isolated.
  await services.assistantFeature.connect();
  services.releaseMigration = new ReleaseSessionMigration({
    services,
    operations: services.operations,
  });
  server.once("listening", () => services.releaseMigration.resumeAfterActivation());
  server.once("listening", () => services.mcpAccess.initialize());
  services.githubTokenMonitor = new GithubTokenMonitor({
    repositories: services.repositories,
    notifications: services.notifications,
    onError: (error) =>
      console.error(
        `AgentPier could not check a GitHub token: ${error?.code || "unknown error"}`,
      ),
  });
  services.systemStatus = new SystemStatus({
    dataDir: config.dataDir,
    sessions: services.sessions,
    notifications: services.notifications,
    // The Gateway is a child of this server; its tree is reported on its own.
    gatewayPid: () => {
      const child = services.assistantRuntime?.child;
      return child?.exitCode === null ? child.pid : null;
    },
    ...config.systemStatus,
    onError: (error) =>
      console.error(
        `AgentPier could not read the system status: ${error?.code || "unknown error"}`,
      ),
  });
  // One listener for both monitors keeps the server below the listener warning limit.
  server.once("listening", () => {
    services.githubTokenMonitor.start();
    services.systemStatus.start();
  });
  server.once("listening", () =>
    stageToolchainsInBackground({ dataDir: config.dataDir }),
  );
  // Marks installs a restart interrupted as failed and prunes in the background.
  server.once("listening", () => {
    try {
      services.mcpPackages?.start();
    } catch (error) {
      console.error(
        `AgentPier could not start MCP packages: ${error?.code || "unknown error"}`,
      );
    }
  });
  server.once("listening", () => {
    const report = (error) =>
      console.error(
        `AgentPier could not resume interrupted sessions: ${error?.code || error?.message || "unknown error"}`,
      );
    services.sessions.onInterrupted = () => services.autoResume.notify().catch(report);
    services.autoResume.initialize().catch(report);
  });
  server.once("listening", () => services.assistantFeature.start());
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(buildHeader(buildIdentity(config.buildDocument)));
  app.use((req, res, next) => {
    if (!isMcpMachinePath(req.path)) return next();
    try {
      authorizeMcpTransport(req, effective());
    } catch (error) {
      return res
        .status(error.status || 403)
        .json({ error: agentText(error.message), ...messageIdentity(error.message) });
    }
    return services.mcpTransport.router(req, res, next);
  });
  app.use((req, res, next) => {
    try {
      authorizeRequest(req, effective());
      next();
    } catch (error) {
      res
        .status(error.status || 403)
        .json({ error: error.message, ...messageIdentity(error.message) });
    }
  });
  app.use("/auth", loginRoutes(services.identity, effective));
  // Every /api router goes through the registry, so the access tests see every route.
  // What a restricted user reaches of the agents; her routes and sockets ask it.
  services.userScope = new UserScope(services);
  const api = createApiRegistry(app, { barrier: services.mutationBarrier });
  services.apiRegistry = api;
  // Authenticated by its single-use OAuth state, not the session cookie.
  api.mount(mcpOAuthCallbackRoutes(services), { guarded: false, beforeLogin: true });
  api.mount(mcpCliOAuthCallbackRoutes(services), { guarded: false, beforeLogin: true });
  app.use("/api", requireLogin(services.identity, effective));
  // Deny by default: restricted users reach only their /api/me routes, the owner never.
  app.use("/api", routeAccess());
  // The owner reads users' private content only under their opt-in.
  app.use("/api", ownerContentGuard(services));
  // Slow mobile links benefit most; downloads stream raw bytes uncompressed.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) =>
        !/^attachment/i.test(String(res.getHeader("Content-Disposition") || "")) &&
        compression.filter(req, res),
    }),
  );
  app.use(auditHttp(services.audit, { onError: services.onError }));
  api.mount(fileTransferStreams(services), { guarded: false });
  api.mount(fileTextRoutes(services), { guarded: false });
  app.use(
    "/api/sessions/:id/chat/attachments",
    express.json({ limit: "15mb", strict: true }),
  );
  app.use(
    "/api/accounts/:id/extensions/skills",
    express.json({ limit: "15mb", strict: true }),
  );
  // Chat input allows 32000 characters; multi-byte text exceeds the global limit.
  app.use("/api/sessions/:id/input", express.json({ limit: "256kb", strict: true }));
  // An agent message (or the queued one) holds 65,536 characters of any script.
  app.use(
    /^\/api\/(?:assistant-conversations|me\/conversations)\/[^/]+\/(?:messages|queued)$/,
    express.json({ limit: "256kb", strict: true }),
  );
  // A gate decision may carry a replacement spec of up to 64 KiB, escaped as JSON.
  app.use(
    /^\/api\/pipeline-runs\/[^/]+\/gate$/,
    express.json({ limit: "256kb", strict: true }),
  );
  app.use(express.json({ limit: "64kb", strict: true }));
  const mount = (router) => api.mount(router);
  mount(artifactsRoutes(services));
  mount(mcpAccessRoutes(services));
  mount(workspaceRoutes(services));
  mount(fileExplorerRoutes(services));
  mount(fileOperationsRoutes(services));
  mount(fileTransfersRoutes(services));
  mount(filesRoutes(services));
  mount(accountsRoutes(services));
  mount(sessionsRoutes(services));
  mount(sshRoutes(services));
  mount(repositoriesRoutes(services));
  mount(extensionsRoutes(services));
  mount(agencyRoutes(services));
  mount(pluginsRoutes(services));
  mount(chatRoutes(services));
  mount(modelsRoutes(services));
  mount(toolsRoutes(services));
  mount(agentbusRoutes(services));
  mount(providerRoutes(services));
  mount(providerConnectionRoutes(services));
  mount(mcpServerRoutes(services));
  mount(mcpCommandRoutes(services));
  mount(mcpDirectoryRoutes(services));
  mount(assistantRoutes(services));
  mount(memoryRoutes(services));
  mount(pipelineDefinitionRoutes(services));
  mount(pipelineRunRoutes(services));
  mount(pipelineQueueRoutes(services));
  mount(auditRoutes(services));
  mount(requestsRoutes(services));
  mount(inboxRoutes(services));
  mount(notificationsRoutes(services));
  mount(remoteRoutes(services));
  mount(settingsSummaryRoutes(services));
  mount(dictationRoutes(services));
  mount(systemStatusRoutes(services));
  mount(usersRoutes(services));
  mount(meAccountRoutes(services));
  mount(meAgentRoutes(services));
  mount(meNotificationRoutes(services));
  api.mount(operationsRoutes(services), { guarded: false });
  mount(healthRoutes(services));
  registerResponses(app);
  const admit = (principal, target) => admitSocket(services, principal, target);
  const wss = attachTerminalWebSocket(server, {
    sessions: services.sessions,
    login: services.identity,
    admit,
    effective,
  });
  const chatWss = attachChatWebSocket(server, {
    sync: services.chatSync,
    streams: services.chatStreams,
    login: services.identity,
    admit,
    effective,
  });
  services.chatWss = chatWss;
  // The agent chats' live feeds, while the agent feature runs.
  services.assistantChatWss = attachAssistantChatWebSocket(server, {
    assistants: () => services.assistants,
    login: services.identity,
    admit,
    effective,
  });
  // The owner's live view of the agents' browsers, while the agent feature runs.
  services.browserWss = attachBrowserWebSocket(server, {
    live: () => services.assistants?.liveView || null,
    login: services.identity,
    admit,
    effective,
    // Assignments and opt-ins change who may watch (socket-access.js).
    changes: (listener) => {
      const events = services.assistants?.events;
      const off = events?.subscribe(listener);
      services.ownerPrivacy.on("changed", listener);
      return () => {
        off?.();
        services.ownerPrivacy.off("changed", listener);
      };
    },
  });
  services.dictationWss = attachDictationWebSocket(server, {
    dictation: () => services.dictation,
    login: services.identity,
    admit,
    effective,
  });
  // Returning the services object itself keeps test seams such as restartService writable.
  return Object.assign(services, {
    app,
    server,
    close: createShutdown({ services, wss, server }),
  });
}
