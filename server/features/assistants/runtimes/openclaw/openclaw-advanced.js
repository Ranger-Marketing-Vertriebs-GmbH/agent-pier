import path from "node:path";
import { readJSON } from "../../../../lib/storage.js";
import { assistantProblem } from "../../assistant-validation.js";

const reloadKinds = new Set(["hot", "none", "restart"]);

function valueAt(config, target) {
  let node = config;
  for (const key of target.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

// A merge patch for one leaf; null removes it.
const patchFor = (target, value) =>
  target
    .split(".")
    .reduceRight((inner, key) => ({ [key]: inner }), value === undefined ? null : value);

/**
 * How OpenClaw's one Gateway takes the advanced settings (runtime-for.js
 * `advancedRuntimes`, advanced-config.js): the shared settings its allow list names
 * (openclaw-config/advanced-settings.js), each an openclaw.json path. A running
 * Gateway takes a `hot` or `none` change live through config.patch; a `restart`
 * change restarts it in maintenance once the owner confirmed, like a web tools
 * change. A stopped Gateway compiles the stored overrides at its next start.
 *
 * `supervisor` is the OpenClaw supervisor (its `paths.root` holds the selected
 * installation); `adapter()` its runtime port. One per supervisor: the reload kinds
 * are read once per runtime version.
 */
export function openClawAdvanced(supervisor, adapter) {
  // config.schema.lookup answers per runtime version, so one read per version.
  let lookupCache = { version: null, kinds: null };
  // The config sub-port of the runtime port.
  const config = () => adapter().config;
  // The allow list and its checks (the config sub-port's compiler), or null while the
  // runtime offers no advanced settings (its `advancedSettings` capability).
  const settings = () =>
    adapter().capabilities().advancedSettings.available
      ? config().compiler.advancedSettings
      : null;
  // The version the next start runs: the selected installation (runtime.json), which
  // after a rollback is not the manifest's. Null when nothing is installed yet.
  const installedVersion = () => {
    const root = supervisor.paths?.root;
    if (!root) return null;
    try {
      const version = readJSON(path.join(root, "runtime.json"), null)?.version;
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  };
  const status = () => {
    const { availability, version: running } = adapter().host.status();
    const ready = availability === "ready" && adapter().host.ready();
    // Only a ready Gateway's own version applies. Otherwise the next start runs the
    // selected installation, which after a rollback differs from the version the
    // last start reported (and a Gateway that never started reports none).
    const version = ready ? running : (installedVersion() ?? running);
    // A Gateway that is starting, stopping or reconnecting compiled (or will
    // compile) its configuration already; a write now would miss it.
    const settled = ready || availability === "disabled" || availability === "failed";
    return {
      enabled: true,
      running: ready,
      settled,
      version: version || null,
      qualified: !version || version === (settings()?.runtime ?? null),
    };
  };
  /**
   * The running Gateway's reload kind per setting id, or null for a path it does not
   * know. Null without a running Gateway: the qualified kinds apply.
   */
  const applies = async (current) => {
    if (!current.running) return null;
    if (lookupCache.version === current.version) return lookupCache.kinds;
    const kinds = {};
    for (const { id, path: target } of settings()?.list || []) {
      try {
        const found = await config().lookup({ path: target });
        kinds[id] = reloadKinds.has(found?.reloadKind) ? found.reloadKind : null;
      } catch (error) {
        // An unknown path is answered; anything else is not a fact about the schema.
        if (!error?.answered) return null;
        kinds[id] = null;
      }
    }
    lookupCache = { version: current.version, kinds };
    return kinds;
  };
  /** What the running Gateway uses now, by setting id; null while none runs. */
  const values = async (current) => {
    if (!current.running) return null;
    try {
      const live = (await config().get()).config || {};
      return Object.fromEntries(
        (settings()?.list || []).map(({ id, path: target }) => [
          id,
          valueAt(live, target),
        ]),
      );
    } catch {
      return null;
    }
  };
  /**
   * Stores a shared setting's value (`undefined` resets it) through `persist()`, as
   * the Gateway can take it now: at once while it is stopped, live through
   * config.patch, or with a confirmed restart, whose failure undoes the stored value
   * (`revert()`). A Gateway in transition, an unapproved version and a path the
   * running Gateway does not know refuse first.
   */
  const store = async (
    setting,
    value,
    { confirmed, persist, revert, admit, restart, askRestart },
  ) => {
    const current = status();
    if (!current.settled) throw assistantProblem("active", 409);
    if (!current.qualified) throw assistantProblem("advancedSettingUnavailable", 409);
    const kinds = await applies(current);
    const reloadKind = kinds ? kinds[setting.id] : setting.reloadKind;
    if (!reloadKind) throw assistantProblem("advancedSettingUnavailable", 409);
    if (!current.running) await admit(persist);
    else if (reloadKind === "restart") {
      if (!confirmed) askRestart();
      try {
        await restart(persist);
      } catch (error) {
        // So the next start does not repeat the failure.
        revert();
        throw error;
      }
    } else
      await admit(async () => {
        // Validated by the Gateway too: a refused value is never stored.
        try {
          await config().patch({
            build: () => ({ patch: patchFor(setting.path, value) }),
          });
        } catch (error) {
          if (error?.key) throw error;
          if (error?.answered && error.code === "INVALID_REQUEST")
            throw assistantProblem("invalid");
          throw assistantProblem("unavailable", 503);
        }
        persist();
      });
  };
  return Object.freeze({ settings, status, applies, values, store });
}
