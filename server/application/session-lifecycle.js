import { nativeModelFor } from "./session-selection.js";
import { serverMessages } from "../lib/i18n/de.js";
import { randomUUID } from "node:crypto";
import { nameValue, problem } from "../lib/storage.js";
import {
  grantAttachmentAccess,
  discardAttachmentAccess,
} from "../features/sessions/attachment-access.js";
import { profileLocation } from "../features/cli-profiles/configuration.js";
export function createSessionLifecycle(services) {
  const {
    config,
    accounts,
    providerAccess,
    providerConnections,
    sessions,
    preferences,
    tools,
    directory,
    github,
    agentbus,
    bindings,
    memoryIntegration,
    requests,
    chat,
    sharedProfiles,
  } = services;
  const activeFor = async (id) =>
    (await sessions.list()).some(
      (session) => session.accountId === id && session.status === "running",
    );
  async function launch(body, login = false, trusted = {}) {
    if (body.agentbus !== undefined && typeof body.agentbus !== "boolean")
      throw problem(serverMessages.sessions.invalidAgentBusSelection);
    const resolved = providerAccess.resolve(body, { login });
    const release = resolved.selection
      ? providerConnections.acquire(resolved.selection.providerConnectionId)
      : () => {};
    try {
      return await launchResolved(body, login, trusted, resolved);
    } finally {
      release();
    }
  }
  async function launchResolved(body, login, trusted, { account, selection }) {
    const nativeModelId = nativeModelFor(body, account, { login });
    trusted.validateAccount?.(account);
    const cwd = await directory(
      body.cwd || (login ? config.home : preferences.get().defaultCwd),
    );
    const name = nameValue(
      body.name ||
        `${account.name}${login ? serverMessages.sessions.loginNameSuffix : ""}`,
    );
    const binaries = Object.fromEntries(
      tools()
        .filter((t) => t.installed)
        .map((t) => [t.id, t.path]),
    );
    const launch = accounts.command(account.id, binaries, login, body.launchMode, {
      modelId: trusted.modelId ?? nativeModelId,
    });
    if ((await sessions.list()).filter((s) => s.status === "running").length >= 30)
      throw problem(serverMessages.sessions.sessionLimitReached, 409);
    if (login && (await activeFor(account.id)))
      throw problem(serverMessages.sessions.stopBeforeLogin, 409);
    if (!login) sharedProfiles?.prepare(account, launch);
    const id = trusted.id || randomUUID();
    if (!login && account.tool === "claude" && !trusted.transformLaunch)
      launch.args.push("--session-id", id);
    const attachments =
      login || account.tool === "shell" || trusted.pipeline?.headless
        ? null
        : grantAttachmentAccess({
            tool: account.tool,
            dataDir: config.dataDir,
            accountId: account.id,
            sessionId: id,
            launch,
            profile:
              account.tool === "opencode" ? profileLocation(accounts, account.id) : null,
          });
    let busLaunch, session;
    try {
      const gitLaunch = await github.prepare({
        id,
        account,
        cwd,
        launch,
        purpose: login ? "login" : undefined,
      });
      busLaunch =
        account.tool === "shell"
          ? { ...gitLaunch, agentbus: { enabled: false } }
          : await agentbus.prepare({
              id,
              account,
              cwd,
              launch: gitLaunch,
              enabled: body.agentbus !== false,
              purpose: login ? "login" : undefined,
            });
      const memoryLaunch = await memoryIntegration.prepare({
        id,
        account,
        cwd,
        launch: busLaunch,
        purpose: login ? "login" : undefined,
      });
      const prepared = await bindings.prepare({
        id,
        account,
        cwd,
        launch: memoryLaunch,
        purpose: login ? "login" : undefined,
      });
      const finalLaunch = trusted.transformLaunch
        ? await trusted.transformLaunch({ id, account, cwd, launch: prepared })
        : await requests.prepare({
            id,
            account,
            cwd,
            launch: prepared,
            purpose: login ? "login" : undefined,
          });
      session = await sessions.create({
        id,
        name,
        tool: account.tool,
        accountId: account.id,
        cwd,
        ...finalLaunch,
        ...(selection ? { access: selection } : {}),
        ...(attachments ? { attachments } : {}),
        ...(trusted.pipeline ? { pipeline: trusted.pipeline } : {}),
        ...(login ? { purpose: "login" } : {}),
      });
    } catch (error) {
      await requests.discard(id).catch(() => {});
      try {
        await memoryIntegration.discard(id);
      } catch {}
      await bindings.discard(id);
      await github.discard(id).catch(() => {});
      await agentbus.discard?.({
        id,
        projectId: busLaunch?.agentbus?.projectId,
      });
      try {
        discardAttachmentAccess(attachments);
      } catch {}
      throw error;
    }
    if (!login && account.tool === "claude") chat.initialize(session, id, "automatic");
    return session;
  }
  return { launch, activeFor };
}
