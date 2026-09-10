import {
  accountSwitchTargets,
  prepareAccountTransfer,
} from "./session-account-transfer.js";
import { codexSandboxArguments } from "../lib/sandbox.js";
import { resolveReloadModel } from "./session-reload-model.js";
import { resumeLaunch, validateReloadLaunch } from "./session-reload-launch.js";
import { currentModel } from "../features/models/model-parser.js";
import { parseSessionActivity } from "../features/sessions/session-activity.js";
import { problem } from "../lib/storage.js";

export function createReloadLifecycle(services) {
  async function prepareReload(session, nativeId, targetAccountId) {
    const { accounts, history, tools, models } = services;
    if (session.agentpierTools?.enabled)
      services.sessionMcp?.validate(session.agentpierTools.selection);
    const content = await history.read(session, nativeId);
    const switching = targetAccountId && targetAccountId !== session.accountId;
    if (
      switching &&
      !accountSwitchTargets(services, session).some((a) => a.id === targetAccountId)
    )
      throw problem(
        "Choose another account for the same CLI. Provider sessions cannot switch accounts.",
        409,
      );
    const account = accounts.get(switching ? targetAccountId : session.accountId);
    if (account.tool !== session.tool) throw problem("The CLI profile changed.", 409);
    const live = session.status === "running" ? await models?.read(session.id) : null;
    if (live?.pending)
      throw problem("Finish the current model selection before reloading.", 409);
    const displayedModel = live?.currentModel;
    const { modelId, reasoningEffort } = resolveReloadModel({
      tool: session.tool,
      displayedModel,
      observedModel: content.observability?.context?.modelId,
      fallbackModel:
        session.nativeModelId ||
        session.provider?.requestedModelId ||
        session.access?.providerModelId,
    });
    const binaries = Object.fromEntries(
      tools()
        .filter((tool) => tool.installed)
        .map((tool) => [tool.id, tool.path]),
    );
    let launch = accounts.command(account.id, binaries, false, session.launchMode, {
      modelId,
    });
    if (reasoningEffort)
      launch.args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    if (session.provider) {
      const previous = session.provider.providerId || session.provider.id;
      const next = launch.provider?.providerId || launch.provider?.id;
      if (previous !== next)
        throw problem(
          "The provider changed. Restore the original provider before reloading.",
          409,
        );
    } else if (launch.provider) throw problem("The account access mode changed.", 409);
    if (session.attachments?.directory && session.tool !== "opencode") {
      launch.args.push("--add-dir", session.attachments.directory);
      if (session.tool === "codex" && launch.launchMode !== "yolo")
        launch.args.push(...codexSandboxArguments());
    }
    launch = resumeLaunch(account.tool, launch, nativeId);
    if (!session.provider && modelId) launch.nativeModelId = modelId;
    await validateReloadLaunch(launch, session.cwd);
    if (switching) {
      for (const other of await services.sessions.list()) {
        if (
          other.id === session.id ||
          other.accountId !== account.id ||
          other.status !== "running"
        )
          continue;
        const bound = await services.bindings.resolve(other);
        if (bound?.id === nativeId)
          throw problem(
            "This conversation is already running in the target account.",
            409,
          );
      }
    }
    const transfer = switching
      ? await prepareAccountTransfer(services, session, account, nativeId)
      : null;
    return {
      account,
      transfer,
      launch,
      nativeId,
      displayedModel,
      recovery:
        session.reload?.state === "failed" &&
        (session.reload.replacementStarted === true || session.status === "stopped") &&
        session.reload.nativeId === nativeId,
    };
  }
  async function restartReload(session, plan) {
    const {
      accounts,
      sessions,
      github,
      agentbus,
      memoryIntegration,
      bindings,
      requests,
      sshIntegration,
      sharedProfiles,
      providerConnections,
    } = services;
    const release = session.access?.providerConnectionId
      ? providerConnections.acquire(session.access.providerConnectionId)
      : () => {};
    try {
      return await sessions.replace(
        session.id,
        async () => {
          const account = accounts.get(plan.account.id);
          if (account.tool !== session.tool)
            throw problem("The CLI profile changed.", 409);
          if (plan.transfer) await plan.transfer.commit();
          sharedProfiles?.prepare(account, plan.launch);
          await requests.discard(session.id);
          await memoryIntegration.discard(session.id);
          await sshIntegration?.discard(session.id);
          let launch = plan.launch;
          const input = () => ({
            id: session.id,
            account,
            cwd: session.cwd,
            launch,
            replace: true,
          });
          launch = await github.prepare(input());
          launch = await agentbus.prepare({
            ...input(),
            enabled: session.agentbus?.enabled !== false,
          });
          launch = await memoryIntegration.prepare(input());
          if (sshIntegration) launch = await sshIntegration.prepare(input());
          if (services.sessionMcp)
            launch = await services.sessionMcp.prepare({
              ...input(),
              selection: session.agentpierTools?.enabled
                ? session.agentpierTools.selection
                : false,
            });
          launch = await bindings.prepare(input());
          launch = await requests.prepare(input());
          return { ...launch, ...(plan.transfer ? { accountId: account.id } : {}) };
        },
        async (current, screen, listCurrent) => {
          if (plan.transfer) {
            if (
              !accountSwitchTargets(services, current).some(
                (a) => a.id === plan.account.id,
              )
            )
              throw problem("The selected account is no longer available.", 409);
            for (const other of await listCurrent()) {
              if (
                other.id === current.id ||
                other.accountId !== plan.account.id ||
                other.status !== "running"
              )
                continue;
              const bound = await bindings.resolve(other);
              if (bound?.id === plan.nativeId)
                throw problem(
                  "This conversation is already running in the target account.",
                  409,
                );
            }
            plan.transfer = await prepareAccountTransfer(
              services,
              current,
              accounts.get(plan.account.id),
              plan.nativeId,
            );
          }
          if (current.status !== "running") return;
          bindings.processCache?.clear();
          const bound = await bindings.resolve(current);
          if (!plan.recovery && bound?.id !== plan.nativeId)
            throw problem(
              "The native conversation changed before reload. No process was stopped.",
              409,
            );
          const raw = await screen();
          const latestModel = currentModel(session.tool, raw);
          if (plan.displayedModel && latestModel && plan.displayedModel !== latestModel)
            throw problem(
              "The model changed before reload. No process was stopped.",
              409,
            );
          // Recheck under the manager lock, after earlier queued input/model operations.
          if (
            session.reload?.interrupt !== true &&
            (requests.hasPending?.(session.id) ||
              parseSessionActivity(session.tool, raw).state !== "idle")
          )
            throw problem("The session is no longer idle. Reload was not started.", 409);
        },
      );
    } finally {
      release();
    }
  }
  return { prepareReload, restartReload };
}
