import { pdfFallbackId } from "../features/assistants/pdf-policy.js";
import { hermesUpdateScope } from "../features/assistants/runtime-update-scope.js";
import {
  createHermesSwitch,
  stageHermesInBackground,
} from "../features/assistants/runtimes/hermes/hermes-provisioning.js";
import {
  createHermesUpdates,
  hermesLifecycle,
} from "../features/assistants/runtimes/hermes/hermes-lifecycle.js";
import { HermesFleet } from "../features/assistants/runtimes/hermes/hermes-fleet.js";
import {
  blockerCodes,
  publicItem,
  runtimeBlockerItems,
} from "../features/assistants/runtime-update-blockers.js";
import {
  confirmedAll,
  resolveItems,
} from "../features/assistants/runtime-update-resolution.js";
import { hermesRunnable } from "../features/assistants/runtimes/hermes/hermes-provisioning.js";
import {
  attachHermesFleet,
  hermesFleetOf,
  runtimeIdOf,
} from "../features/assistants/runtimes/runtime-for.js";

/** The agents OpenClaw runs: every agent that does not run on its own Hermes set. */
export const openClawProfiles = (profiles) =>
  profiles.filter((profile) => runtimeIdOf(profile) === "openclaw");

/**
 * The Hermes fleet of an assistant graph (ADR 0006 decision 4): one process set per
 * Hermes agent, resolved through the OpenClaw `supervisor` every caller passes
 * (runtime-for.js). Sets run while Hermes is enabled and installed; an agent on
 * "Every command" (`shell: "approval"`, `shellEveryCommand`) asks before each command.
 */
export function hermesAgentFleet(supervisor, { dataDir, store }) {
  return attachHermesFleet(
    supervisor,
    new HermesFleet({
      dataDir,
      available: () => hermesRunnable(dataDir),
      strict: (agentId) => {
        const profile = store.listAssistants().find((p) => p.runtimeAgentId === agentId);
        return profile?.shell === "approval" && profile.shellEveryCommand === true;
      },
    }),
  );
}

/**
 * The owner's PDF fallback (pdf-model-settings.js) as a Hermes home compiles it
 * (hermes-config/pdf.js): the connection a model lease names (`provider`, or
 * `chatgpt` for a ChatGPT login) and whether its model takes images; null without a
 * usable one or for an agent whose own model (`own`) takes images. Never throws.
 */
export async function hermesPdfFallback(models, selection, own) {
  if (!models || !selection?.ready) return null;
  const model = { connectionId: selection.connectionId, modelId: selection.modelId };
  let lease;
  try {
    // An agent whose own model takes images (the policy's own answer, also for an
    // OpenRouter model the compiled section cannot tell) never needs the fallback.
    if (own && models.imageInput(own) === true) return null;
    lease = await models.resolve(model);
    const images = models.imageInput(model) === true;
    const id = pdfFallbackId(model);
    if (lease.chatgpt) return { chatgpt: { ...lease.chatgpt }, images, id };
    return lease.provider ? { provider: lease.provider, images, id } : null;
  } catch {
    return null;
  } finally {
    lease?.release?.();
  }
}

/**
 * What a Hermes agent's apply reads beside its record (AssistantConfig
 * applyOwnProcess): the team bridge its team plugin calls, started for it when the
 * OpenClaw start has not yet (TeamBridge.start is idempotent), none while it cannot;
 * and the browser app AgentPier launches its Chromium with, whether that app may
 * open a window, and the owner's private-network setting (web-tools-changes.js); the
 * owner's web search settings (hermes-config/web.js); and the model proxy
 * (model-logins/runtime-proxy.js) for a ChatGPT login, and the login AgentPier holds
 * that the agent creates images with through it (model-accounts.js heldImageLogin);
 * and the owner's PDF fallback (hermesPdfFallback).
 */
export const hermesApplyWiring = ({ bridge, webTools, proxy }) => ({
  hermesInputs: async (assistant) => {
    await webTools?.prepareBrowser?.();
    const detected = webTools?.detect?.();
    // AgentPier's model proxy, through which the agent reaches a ChatGPT login
    // AgentPier holds, with a credential for this agent and that login alone.
    const url = proxy ? await proxy.start().catch(() => null) : null;
    return {
      modelProxy: url && {
        url,
        credentialFor: (profileId) =>
          proxy.credential(["chatgpt", assistant.runtimeAgentId, profileId]),
      },
      imageLogin: url
        ? (bridge.assistants?.accounts?.heldImageLogin?.(assistant.model?.connectionId) ??
          null)
        : null,
      connection: await bridge.start().catch(() => null),
      browser: detected?.available
        ? {
            executablePath: detected.executablePath,
            visible: detected.visible?.available === true,
            allowPrivateNetwork: webTools.network().allowPrivateNetwork === true,
          }
        : null,
      // The owner's web search provider and its key (web-search-settings.js resolve).
      web: webTools?.webSearch ? { search: webTools.webSearch.resolve() } : undefined,
      pdfFallback:
        webTools?.pdf && assistant
          ? await hermesPdfFallback(
              bridge.assistants?.models,
              webTools.pdf(),
              assistant.model,
            )
          : undefined,
    };
  },
});

const stableCode = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;

// The Hermes fleet of the running agent services, or null while they are off.
const fleetOf = (services) =>
  services.assistants?.runtime ? hermesFleetOf(services.assistants.runtime) : null;
const hermesAgents = (services) =>
  (services.assistants?.store.listAssistants() || []).filter(
    (a) => a.runtime === "hermes",
  );

/**
 * The host the update journal (runtime-updates.js) drives for Hermes: every Hermes
 * agent's process set at once. Stop ends them all, start starts those not archived,
 * and the lifecycle methods are Hermes's (hermes-lifecycle.js).
 */
export function hermesUpdateHost(services) {
  const sets = () => fleetOf(services)?.list() || [];
  const status = () => ({
    availability: sets().some(
      ({ runtime }) => runtime.host.status().availability !== "disabled",
    )
      ? "ready"
      : "disabled",
    sync: null,
    version: null,
    diagnostic: null,
  });
  const fleet = {
    status,
    generationId: null,
    async assertStopped() {
      for (const { runtime } of sets()) await runtime.host.assertStopped();
    },
  };
  return {
    ...hermesLifecycle(fleet),
    status,
    start: async () => {
      await fleetOf(services)?.startAll(hermesAgents(services));
    },
    stop: async () => {
      await fleetOf(services)?.stopAll();
    },
  };
}

// No AgentPier maintenance is needed to swap Hermes: only Hermes agents stop, and a
// failed start rolls the installation and their homes back to the snapshot. What
// blocks it is the work of Hermes agents alone, as OpenClaw's update names it
// (runtime-update-blockers.js runtimeBlockerItems): turns and chat summaries in their
// chats and their routine runs under way. "Pause agents and update" resolves the
// items the owner confirmed as for OpenClaw (runtime-update-resolution.js): turns
// stopped, unknown outcomes reviewed, routine runs waited for.
export function hermesUpdateMaintenance(services) {
  const blockerItems = async ({ settle = true } = {}) => {
    if (!services.assistants) return [];
    if (settle) await services.assistants.settleUserTurns?.();
    return runtimeBlockerItems(services, "hermes");
  };
  return {
    enter: async () => {},
    leave: async () => {},
    quiesce: async () => {},
    blockerItems,
    blockers: async () => blockerCodes(await blockerItems()),
    async resolve(confirmed, options) {
      const items = await blockerItems();
      if (!items.length || !confirmedAll(items, confirmed)) return items;
      return resolveItems(services, items, () => blockerItems(), options);
    },
    async validate() {
      for (const { runtime } of fleetOf(services)?.list() || [])
        if (runtime.host.status().availability === "failed")
          throw Object.assign(Error("HERMES_UPDATE_VALIDATION_FAILED"), {
            code: "HERMES_UPDATE_VALIDATION_FAILED",
          });
    },
  };
}

/**
 * The owner's Hermes Agent switch (ADR 0006): `state()`, `enable()` (records the
 * opt-in and installs the pinned runtime in the background; the Hermes agents start
 * once it is installed), `disable()` (their process sets stop), `update()` (installs
 * the pinned version beside the selected one and activates it through the update
 * journal, restarting the Hermes agents; a failed start rolls back; work of Hermes
 * agents blocks it, `{ resolveBlockers, items }` resolves the items the owner
 * confirmed, `blockerPreview()` lists them and the state names those of the last
 * refused update as `blockerItems`), and `start()` at
 * server start, which installs or stages the pinned runtime when Hermes is enabled
 * and this AgentPier pins one that is not installed yet (also after an AgentPier
 * update). `services` is the application's, read lazily: agent services exist only
 * while agents are on.
 */
export function createHermesRuntime({ config, services = {} }) {
  const { dataDir } = config;
  const hermes = createHermesSwitch({ dataDir });
  const base = hermes.state;
  let updating = null;
  let updateError = null;
  let blocked = [];
  hermes.state = () => {
    const state = base();
    return {
      ...state,
      error: state.error || updateError,
      blockerItems: blocked,
      updating: !!updating,
      // A newer pin, or the same release with an extra it lacks (hermes-install.js).
      updateAvailable: state.installed && !state.current,
      agents: hermesAgents(services).length,
    };
  };
  const enable = hermes.enable;
  // Once the background installation settled, the Hermes agents start.
  hermes.enable = async () => {
    await enable();
    hermes
      .settled()
      .then(() => {
        const now = hermes.state();
        if (now.enabled && now.installed)
          return fleetOf(services)?.startAll(hermesAgents(services));
      })
      .catch(() => {});
    return hermes.state();
  };
  const disable = hermes.disable;
  hermes.disable = async () => {
    await disable();
    await fleetOf(services)?.stopAll();
    return hermes.state();
  };
  const journal = () =>
    createHermesUpdates({
      dataDir,
      host: hermesUpdateHost(services),
      maintenance: hermesUpdateMaintenance(services),
      // Its agents' folders of the shared workspace root, and no other's.
      scope: () => hermesUpdateScope(services.assistants?.store),
    });
  hermes.update = async (resolution) => {
    const state = hermes.state();
    if (updating || !state.enabled || !state.installed) return state;
    updateError = null;
    blocked = [];
    const updates = journal();
    updating = (async () => {
      await updates.stage();
      if (updates.status().candidateReady) await updates.activate(resolution);
    })()
      .catch((error) => {
        updateError = stableCode(error, "HERMES_UPDATE_FAILED");
        // The work that refused it, as the owner resolves it.
        if (updateError === "UPDATE_BLOCKED") blocked = updates.status().blockerItems;
      })
      .finally(() => {
        updating = null;
        hermes.onChange?.();
      });
    return hermes.state();
  };
  hermes.updating = () => updating || Promise.resolve();
  hermes.blockerPreview = async () =>
    (await hermesUpdateMaintenance(services).blockerItems({ settle: false })).map(
      publicItem,
    );
  hermes.start = () => stageHermesInBackground({ dataDir });
  return hermes;
}
