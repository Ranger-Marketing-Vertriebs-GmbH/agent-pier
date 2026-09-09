import { serverMessages } from "../lib/i18n/de.js";
export function createShutdown({ services, wss, server }) {
  const { agentbus, installer, plugins, repositories, extensions, history, sessions } =
    services;
  async function close() {
    await services.reload?.close();
    services.accountAuthStatus?.close();
    services.agency?.close();
    await services.mcpTransport?.close();
    await services.operationsEvents?.close();
    await services.operations?.close();
    await services.pipelines?.close();
    await services.requests?.close();
    await services.notifications?.close();
    await agentbus.close();
    await installer.close();
    await plugins.close();
    await repositories.close();
    await extensions.close();
    await history.close();
    for (const ws of wss.clients) ws.close(1001, serverMessages.common.serverRestarting);
    await sessions.close();
    await services.memoryIntegration.close();
    services.memory.close();
    services.mcpTools?.close();
    services.mcpAccess?.close();
    services.audit.close();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return close;
}
