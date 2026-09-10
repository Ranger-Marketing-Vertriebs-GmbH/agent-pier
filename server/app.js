import { SessionReload } from "./features/sessions/session-reload.js";
import { sshRoutes } from "./http/routes/ssh.js";
import { LoginStore } from "./features/login/login-store.js";
import { loginRoutes, requireLogin } from "./http/login.js";
import { agencyRoutes } from "./http/routes/agency.js";
import { filesRoutes } from "./http/routes/files.js";
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
import { applicationVersion } from "./features/operations/version.js";
import { operationsRoutes } from "./http/routes/operations.js";
import { requestsRoutes } from "./http/routes/requests.js";
import { notificationsRoutes } from "./http/routes/notifications.js";
import { memoryRoutes } from "./http/routes/memory.js";
import { providerRoutes } from "./http/routes/providers.js";
import express from "express";
import http from "node:http";
import { createServices } from "./application/services.js";
import { createSessionLifecycle } from "./application/session-lifecycle.js";
import { createPipelineServices } from "./application/pipelines.js";
import { pipelineDefinitionRoutes } from "./http/routes/pipeline-definitions.js";
import { pipelineRunRoutes } from "./http/routes/pipeline-runs.js";
import { auditHttp } from "./features/audit/audit-http.js";
import { auditRoutes } from "./http/routes/audit.js";
import { guardMutations } from "./application/mutation-barrier.js";
import { createShutdown } from "./application/shutdown.js";
import { directoryResolver } from "./lib/directories.js";
import { detectTools } from "./features/accounts/account-store.js";
import { toolBinDirectories } from "./features/tools/tool-paths.js";
import { authorizeRequest, securityHeaders } from "./http/security.js";
import { registerResponses } from "./http/responses.js";
import { attachTerminalWebSocket } from "./http/terminal-websocket.js";
import { attachChatWebSocket } from "./http/chat-websocket.js";
import { workspaceRoutes } from "./http/routes/workspace.js";
import { accountsRoutes } from "./http/routes/accounts.js";
import { sessionsRoutes } from "./http/routes/sessions.js";
import { repositoriesRoutes } from "./http/routes/repositories.js";
import { extensionsRoutes } from "./http/routes/extensions.js";
import { pluginsRoutes } from "./http/routes/plugins.js";
import { chatRoutes } from "./http/routes/chat.js";
import { modelsRoutes } from "./http/routes/models.js";
import { toolsRoutes } from "./http/routes/tools.js";
import { agentbusRoutes } from "./http/routes/agentbus.js";

export async function createApplication(config) {
  const app = express();
  const server = http.createServer(app);
  const services = await createServices(config);
  services.login = new LoginStore(config);
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
  Object.assign(services, await createPipelineServices(services));
  services.operationsEvents = new OperationsEvents(services);
  services.events.current = services.operationsEvents;
  await services.operationsEvents.poll();
  const instanceId = randomUUID();
  const effective = () => ({
    ...config,
    port: server.address()?.port || config.port,
  });
  Object.assign(services, createMcpServices(services, effective));
  server.once("listening", () => services.mcpAccess.initialize());
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use((req, res, next) => {
    if (!isMcpMachinePath(req.path)) return next();
    try {
      authorizeMcpTransport(req, effective());
    } catch (error) {
      return res.status(error.status || 403).json({ error: error.message });
    }
    return services.mcpTransport.router(req, res, next);
  });
  app.use((req, res, next) => {
    try {
      authorizeRequest(req, effective());
      next();
    } catch (error) {
      res.status(error.status || 403).json({ error: error.message });
    }
  });
  app.use("/auth", loginRoutes(services.login, effective));
  app.use("/api", requireLogin(services.login, effective));
  app.use(auditHttp(services.audit, { onError: services.onError }));
  app.use(
    "/api/sessions/:id/chat/attachments",
    express.json({ limit: "15mb", strict: true }),
  );
  app.use(
    "/api/accounts/:id/extensions/skills",
    express.json({ limit: "15mb", strict: true }),
  );
  app.use(express.json({ limit: "64kb", strict: true }));
  const mount = (router) =>
    app.use("/api", guardMutations(router, services.mutationBarrier));
  mount(mcpAccessRoutes(services));
  mount(workspaceRoutes(services));
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
  mount(memoryRoutes(services));
  mount(pipelineDefinitionRoutes(services));
  mount(pipelineRunRoutes(services));
  mount(auditRoutes(services));
  mount(requestsRoutes(services));
  mount(notificationsRoutes(services));
  app.use("/api", operationsRoutes(services));
  app.get("/api/health", (_req, res) =>
    res.json({
      application: "agentpier",
      version: applicationVersion(),
      instanceId,
      warnings: [...services.operationalWarnings],
    }),
  );
  registerResponses(app);
  const wss = attachTerminalWebSocket(server, {
    sessions: services.sessions,
    login: services.login,
    effective,
  });
  const chatWss = attachChatWebSocket(server, {
    sessions: services.sessions,
    chat: services.chat,
    chatImages: services.chatImages,
    events: services.chatEvents,
    login: services.login,
    effective,
  });
  services.chatWss = chatWss;
  return {
    ...services,
    app,
    server,
    close: createShutdown({ services, wss, server }),
  };
}
