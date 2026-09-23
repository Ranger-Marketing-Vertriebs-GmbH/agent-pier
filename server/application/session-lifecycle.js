import { createReloadLifecycle } from "./session-reload-lifecycle.js";
import { nativeModelFor } from "./session-selection.js";
import { serverMessages } from "../lib/i18n/de.js";
import { randomUUID } from "node:crypto";
import { nameValue, problem } from "../lib/storage.js";
import {
  grantAttachmentAccess,
  discardAttachmentAccess,
} from "../features/sessions/attachment-access.js";
import { profileLocation } from "../features/cli-profiles/configuration.js";
import { addGrant } from "../features/nono/sandbox-grants.js";
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
    sshSessions,
    nonoSandbox,
  } = services;
  const reservations = new Map();
  const accountLaunches = new Map();
  const accountMutations = new Set();
  function acquireAccount(id) {
    if (accountMutations.has(id))
      throw problem(serverMessages.common.profileChanged, 409);
    const key = Symbol();
    accountLaunches.set(key, id);
    return () => accountLaunches.delete(key);
  }
  async function withAccountUsage(id, operation) {
    const release = acquireAccount(id);
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async function mutateAccount(id, operation) {
    if (accountMutations.has(id))
      throw problem(serverMessages.common.profileChanged, 409);
    accountMutations.add(id);
    try {
      return await operation();
    } finally {
      accountMutations.delete(id);
    }
  }
  let reservationQueue = Promise.resolve();
  const reserve = (account, login) => {
    const operation = reservationQueue.then(async () => {
      const running = (await sessions.list()).filter(
        (session) => session.status === "running",
      );
      if (running.length + reservations.size >= 30)
        throw problem(serverMessages.sessions.sessionLimitReached, 409);
      if (
        running.some(
          (session) =>
            session.accountId === account.id && (login || session.purpose === "login"),
        ) ||
        [...reservations.values()].some(
          (item) => item.accountId === account.id && (login || item.login),
        )
      )
        throw problem(serverMessages.sessions.stopBeforeLogin, 409);
      const key = Symbol();
      reservations.set(key, { accountId: account.id, login });
      return () => reservations.delete(key);
    });
    reservationQueue = operation.catch(() => {});
    return operation;
  };
  const runningFor = async (id) =>
    (await sessions.list()).some(
      (session) => session.accountId === id && session.status === "running",
    );
  const activeFor = async (id) => {
    if ([...accountLaunches.values()].includes(id)) return true;
    const running = await runningFor(id);
    return running || [...accountLaunches.values()].includes(id);
  };
  async function launch(body, login = false, trusted = {}) {
    if (body.agentbus !== undefined && typeof body.agentbus !== "boolean")
      throw problem(serverMessages.sessions.invalidAgentBusSelection);
    const sshIds = sshSessions?.validate(body.sshAccessIds);
    if (login && sshIds?.length)
      throw problem(serverMessages.ssh.loginSessionsUnsupported);
    if (body.nonoProfile !== undefined && typeof body.nonoProfile !== "string")
      throw problem(serverMessages.sessions.invalidSandboxProfile);
    if (body.nonoProfile && login)
      throw problem(serverMessages.sessions.sandboxNotForLogin);
    if (body.nonoProfile && trusted.pipeline)
      throw problem(serverMessages.sessions.sandboxNotForPipeline);
    if (body.agentpierTools && (login || trusted.pipeline))
      throw problem(serverMessages.sessions.toolsStandaloneOnly);
    services.sessionMcp?.validate(body.agentpierTools);
    const resolved = providerAccess.resolve(body, { login });
    // Claim usage synchronously before the first asynchronous launch preparation.
    const releaseAccount = acquireAccount(resolved.account.id);
    let release = () => {};
    try {
      if (resolved.selection)
        release = providerConnections.acquire(resolved.selection.providerConnectionId);
      const unreserve = await reserve(resolved.account, login);
      try {
        return await launchResolved(body, login, trusted, resolved, sshIds);
      } finally {
        unreserve();
      }
    } finally {
      release();
      releaseAccount();
    }
  }
  async function launchResolved(body, login, trusted, { account, selection }, sshIds) {
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
    let launch = accounts.command(account.id, binaries, login, body.launchMode, {
      modelId: trusted.modelId ?? nativeModelId,
    });
    if ((await sessions.list()).filter((s) => s.status === "running").length >= 30)
      throw problem(serverMessages.sessions.sessionLimitReached, 409);
    if (login && (await runningFor(account.id)))
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
    // grantAttachmentAccess returns the attachment record, not a launch, and is the
    // last step that edits launch.args in place, so the grant is declared here.
    if (attachments)
      launch = addGrant(launch, { access: "allow", path: attachments.directory });
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
      const sshLaunch = services.sshIntegration
        ? await services.sshIntegration.prepare({
            id,
            account,
            cwd,
            launch: memoryLaunch,
            purpose: login ? "login" : undefined,
            pipeline: trusted.pipeline,
            headless: trusted.pipeline?.headless,
            sandboxProfile: body.nonoProfile || null,
            sshAccessIds: sshIds,
          })
        : memoryLaunch;
      const mcpLaunch = services.sessionMcp
        ? await services.sessionMcp.prepare({
            id,
            account,
            cwd,
            launch: sshLaunch,
            purpose: login ? "login" : undefined,
            pipeline: trusted.pipeline,
            selection: body.agentpierTools,
          })
        : sshLaunch;
      const prepared = await bindings.prepare({
        id,
        account,
        cwd,
        launch: mcpLaunch,
        purpose: login ? "login" : undefined,
      });
      const composed = trusted.transformLaunch
        ? await trusted.transformLaunch({ id, account, cwd, launch: prepared })
        : await requests.prepare({
            id,
            account,
            cwd,
            launch: prepared,
            purpose: login ? "login" : undefined,
          });
      // Last in the chain: every grant has been declared by now, and the launch
      // the session manager stores must not carry them. A rejection here still
      // unwinds through the adapter cleanup below.
      const finalLaunch = await nonoSandbox.prepare({
        launch: composed,
        profile: body.nonoProfile || null,
      });
      session = await sessions.create({
        id,
        name,
        tool: account.tool,
        accountId: account.id,
        cwd,
        ...finalLaunch,
        sandbox: { profile: body.nonoProfile || null },
        ...(nativeModelId ? { nativeModelId } : {}),
        ...(selection ? { access: selection } : {}),
        ...(attachments ? { attachments } : {}),
        ...(trusted.pipeline ? { pipeline: trusted.pipeline } : {}),
        ...(login ? { purpose: "login" } : {}),
      });
      if (body.sshAccessIds?.length) await sshSessions.set(session, body.sshAccessIds);
    } catch (error) {
      services.sessionMcp?.discard(id);
      sshSessions?.discard(id);
      if (session) {
        await sessions.stop(id).catch(() => {});
        await sessions.remove(id).catch(() => {});
      }
      await services.sshIntegration?.discard(id);
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
  return {
    launch,
    activeFor,
    mutateAccount,
    withAccountUsage,
    ...createReloadLifecycle(services),
  };
}
