import { resolveReloadModel } from "./session-reload-model.js";
import { resumeLaunch, validateReloadLaunch } from "./session-reload-launch.js";
import { currentModel } from "../features/models/model-parser.js";
import { parseSessionActivity } from "../features/sessions/session-activity.js";
import { problem } from "../lib/storage.js";

export function createReloadLifecycle(services) {
  async function prepareReload(session, nativeId) {
    const { accounts, history, tools, models } = services;
    const content = await history.read(session, nativeId);
    const account = accounts.get(session.accountId);
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
    if (session.attachments?.directory && session.tool !== "opencode")
      launch.args.push("--add-dir", session.attachments.directory);
    launch = resumeLaunch(account.tool, launch, nativeId);
    if (!session.provider && modelId) launch.nativeModelId = modelId;
    await validateReloadLaunch(launch, session.cwd);
    return {
      account,
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
          launch = await bindings.prepare(input());
          return requests.prepare(input());
        },
        async (current, screen) => {
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
