import { serverMessages } from "../lib/i18n/de.js";
export function createShutdown({ services, wss, server }) {
  const { agentbus, installer, plugins, repositories, extensions, history, sessions } =
    services;
  async function close() {
    // npm and uv run in their own process groups and must not outlive AgentPier: their
    // stop starts first, so its bound (McpPackages#close) ends well before the forced
    // exit in server/index.js. It is awaited before the server store closes, because
    // a settling job still writes its package record.
    const packagesClosed = services.mcpPackages?.close();
    // Dictations end before the speech connection they relay through closes.
    services.dictation?.close();
    // Closes only the assistant services that the opt-in actually created.
    await services.assistantFeature?.close();
    services.chatStreams?.close();
    // Ends the inbox event streams, which would otherwise keep the server open.
    services.inbox?.close();
    for (const socketServer of [
      wss,
      services.chatWss,
      services.assistantChatWss,
      services.browserWss,
      services.dictationWss,
    ])
      for (const ws of socketServer?.clients || []) {
        ws.close(1001, serverMessages.common.serverRestarting);
        const timeout = setTimeout(() => ws.terminate(), 1000);
        timeout.unref();
        ws.once("close", () => clearTimeout(timeout));
      }
    await services.artifacts?.close();
    await services.files?.close();
    await services.autoResume?.close();
    await services.reload?.close();
    await services.sshManagement?.close();
    services.accountAuthStatus?.close();
    services.codexMcpLogins?.close();
    services.agency?.close();
    await services.sessionMcp?.close();
    await services.mcpTransport?.close();
    await services.operationsEvents?.close();
    await services.githubTokenMonitor?.close();
    await services.systemStatus?.close();
    services.chatEvents?.close();
    await services.operations?.close();
    await services.pipelines?.close();
    await services.requests?.close();
    await services.notifications?.close();
    await agentbus.close();
    await installer.close();
    await plugins.close();
    await repositories.close();
    await extensions.close();
    await packagesClosed;
    try {
      services.mcpServers?.close();
    } catch {}
    await history.close();
    for (const socketServer of [
      wss,
      services.chatWss,
      services.assistantChatWss,
      services.browserWss,
    ])
      for (const ws of socketServer?.clients || [])
        ws.close(1001, serverMessages.common.serverRestarting);
    await sessions.close();
    await services.memoryIntegration.close();
    services.memory.close();
    services.mcpTools?.close();
    services.mcpAccess?.close();
    services.audit.close();
    for (const socketServer of [
      wss,
      services.chatWss,
      services.assistantChatWss,
      services.browserWss,
    ])
      if (socketServer) await new Promise((resolve) => socketServer.close(resolve));
    if (server.listening)
      await new Promise((resolve) => {
        // Existing keep-alive clients can keep issuing requests while close()
        // drains. Bound that final drain after the services and WebSockets stop.
        const timeout = setTimeout(() => server.closeAllConnections(), 1000);
        timeout.unref();
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
  }
  return close;
}
