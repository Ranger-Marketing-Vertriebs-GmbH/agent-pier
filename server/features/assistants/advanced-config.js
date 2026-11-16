import { restartRequired } from "./assistant-provider-synchronization.js";
import { assistantProblem } from "./assistant-validation.js";
import { advancedRuntimes, compilerFor, runtimeIdOf } from "./runtimes/runtime-for.js";
import { hostFields, storedSettings } from "./runtimes/runtime-settings.js";
import { validFieldValue } from "./runtimes/runtime-surfaces.js";
import {
  sharedSetting,
  sharedSettings,
  validSharedValue,
} from "./runtimes/shared-settings.js";

// The key the shared store keeps setting `id` under: the path of the default
// runtime's compiler, as it always was (openclaw_overrides), so no row moves and an
// older AgentPier reads the store unchanged. Undefined for a setting it has no path
// for, which therefore cannot be stored.
const storeKey = (id) => compilerFor(null).advancedSettings?.byId(id)?.path;

/**
 * The owner's stored shared advanced settings by setting id (`{ [id]: value }`), as a
 * runtime that maps them by id compiles them (Hermes, hermes-config/advanced.js);
 * undefined when the store cannot be read, which leaves their keys as they are.
 */
export function advancedValues(overrides) {
  try {
    const settings = compilerFor(null).advancedSettings;
    return Object.fromEntries(
      overrides.list().flatMap(({ path: target, value }) => {
        const setting = settings?.byPath(target);
        return setting ? [[setting.id, value]] : [];
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * The owner's advanced settings for all agents (Agents › Runtime › Advanced,
 * docs/adr/0007-runtime-descriptor.md). This module names no runtime: it iterates the
 * runtimes of the registry (`runtimes(supervisor)`, runtime-for.js advancedRuntimes),
 * each with its descriptor and the host port that says how it takes a setting.
 *
 * - A **shared** setting is AgentPier's (runtimes/shared-settings.js). A runtime
 *   takes it when its compiler's `advancedSettings` names its id; how a running host
 *   takes a change (`hot`, `none`, `restart`) is that entry's `reloadKind`, or what
 *   the host answers at read time (`host.applies`). The values live in the override
 *   store (`overrides`), keyed as they always were (storeKey). A save runs through
 *   every taking runtime that writes its host itself (`host.store`, the outermost
 *   first; the innermost stores), then tells every taking runtime (`host.stored`).
 * - A runtime's **own** setting is a field of a described surface of its descriptor
 *   (runtime-settings.js), stored in `settings` by runtime id and field id. The
 *   runtime's `host.storeOwn` stores it and makes the host take it as the field's
 *   `apply` says.
 *
 * A host port (all but `settings` and `status` optional): `settings()` (the
 * compiler's `advancedSettings`, or null), `status()` (`{ enabled, running, settled,
 * version, qualified }`), `applies(status)` and `values(status)` (by setting id, or
 * null), `store(setting, value, context)`, `stored(setting, context)`,
 * `storeOwn(field, value, context)`. `context` is `{ confirmed, persist, revert,
 * admit, restart, askRestart, applyAgents }`: `persist()` stores the value, `revert()`
 * undoes that after a failed restart, `admit(operation)` serializes with the agents
 * service, `restart(operation)` restarts the agent service in maintenance around
 * `operation`, `askRestart()` throws the restart question the owner confirms, and
 * `applyAgents()` applies every agent of the runtime in the background.
 */
export class AdvancedConfig {
  constructor({
    assistants,
    overrides,
    settings = null,
    synchronization,
    usage,
    audit,
    runtimes = advancedRuntimes,
  }) {
    Object.assign(this, { assistants, overrides, synchronization, usage, audit });
    this.ownStore = settings;
    this.listRuntimes = runtimes;
  }
  get runtime() {
    return this.assistants.runtime;
  }
  /** The runtimes, each with the described advanced fields of its own. */
  runtimes() {
    return this.listRuntimes(this.runtime).map((runtime) => ({
      ...runtime,
      fields: hostFields(runtime.descriptor),
    }));
  }
  // How many agents (not archived) run on runtime `id`.
  agents(id) {
    const profiles = this.assistants.store?.listAssistants?.() || [];
    return profiles.filter((p) => runtimeIdOf(p) === id && !p.archivedAt).length;
  }
  // Applies every agent of runtime `id` in the background: each restarts only if its
  // configuration changed. A failure retries with the agent's next apply.
  applyAgents(id) {
    const { store, config } = this.assistants;
    if (typeof config?.apply !== "function") return;
    for (const profile of store?.listAssistants?.() || [])
      if (runtimeIdOf(profile) === id && !profile.archivedAt)
        Promise.resolve()
          .then(() => config.apply(profile.id))
          .catch(() => {});
  }
  // What a host port's write gets beside the change itself.
  context(runtime, { confirmed, persist, revert }) {
    return {
      confirmed,
      persist,
      revert,
      admit: (operation) => this.assistants.admit(operation),
      restart: (operation) => this.synchronization.restartGateway(operation),
      askRestart: () => {
        throw restartRequired("advancedRestartRequired", this.usage?.() || undefined);
      },
      applyAgents: () => this.applyAgents(runtime.id),
    };
  }
  /**
   * Every runtime with its state, agents and own settings, and every shared setting
   * with its stored override and how each runtime that takes it does.
   */
  async get() {
    const read = [];
    for (const runtime of this.runtimes()) {
      const { host } = runtime;
      const status = host.status();
      const taken = host.settings();
      read.push({
        runtime,
        status,
        taken,
        applies: taken ? ((await host.applies?.(status)) ?? null) : null,
        values: taken ? ((await host.values?.(status)) ?? null) : null,
      });
    }
    const stored = new Map(this.overrides.list().map((row) => [row.path, row]));
    return {
      runtimes: read.map(({ runtime, status }) => ({
        id: runtime.id,
        name: runtime.name,
        shortName: runtime.shortName,
        // `shared`: one host for all its agents; `perAgent`: one per agent.
        process: runtime.process,
        enabled: status.enabled,
        running: status.running,
        version: status.version ?? null,
        qualified: status.qualified,
        agents: this.agents(runtime.id),
        own: this.ownFields(runtime),
      })),
      settings: sharedSettings.flatMap((setting) => {
        const runtimes = Object.fromEntries(
          read.flatMap(({ runtime, status, taken, applies, values }) => {
            const entry = taken?.byId(setting.id);
            if (!entry) return [];
            // null: the running host does not know the setting.
            const live = applies ? applies[setting.id] : entry.reloadKind;
            return [
              [
                runtime.id,
                {
                  apply: live || entry.reloadKind,
                  available: status.qualified && live !== null,
                  // What the running host uses now; null before a start, while
                  // unset or for a runtime that does not tell.
                  current: values?.[setting.id] ?? null,
                },
              ],
            ];
          }),
        );
        if (!Object.keys(runtimes).length) return [];
        const { id, group, type, options, format, unit, minimum, maximum, fallback } =
          setting;
        return [
          {
            id,
            group,
            type,
            ...(options && { options: [...options] }),
            ...(format && { format }),
            ...(unit && { unit }),
            ...(minimum !== undefined && { minimum }),
            ...(maximum !== undefined && { maximum }),
            fallback,
            override: stored.get(storeKey(id))?.value ?? null,
            runtimes,
          },
        ];
      }),
    };
  }
  // The described fields of `runtime` as the page shows them: the description, the
  // surface it belongs to and the stored value (null: the default applies).
  ownFields(runtime) {
    if (!runtime.fields.length) return [];
    const stored = this.ownStore ? storedSettings(runtime.descriptor, this.ownStore) : {};
    return runtime.fields.map((field) => ({
      ...field,
      ...(field.options && { options: [...field.options] }),
      value: Object.hasOwn(stored, field.id) ? stored[field.id] : null,
    }));
  }
  /** Sets one shared setting by its id; `value: null` resets it to the default. */
  async save(id, value, { confirmed = false } = {}) {
    const setting = typeof id === "string" ? sharedSetting(id) : undefined;
    if (!setting) throw assistantProblem("invalid");
    const key = storeKey(setting.id);
    const takers = this.runtimes()
      .map((runtime) => ({ runtime, entry: runtime.host.settings()?.byId(setting.id) }))
      .filter(({ entry }) => entry);
    if (!key || !takers.length) throw assistantProblem("advancedSettingUnavailable", 409);
    if (value !== null && !validSharedValue(setting, value))
      throw assistantProblem("invalid");
    const next = value === null ? undefined : value;
    const change = this.change({
      read: () => this.overrides.get(key),
      write: (to) =>
        to === undefined ? this.overrides.remove(key) : this.overrides.set(key, to),
      record: (action, from, to, outcome) =>
        this.record(action, setting.id, { setting: setting.id, from, to }, outcome),
    });
    const persist = () => change.persist(next);
    // Each runtime that writes its host itself wraps the ones after it; the
    // innermost stores.
    const write = takers.reduceRight(
      (inner, { runtime, entry }) =>
        typeof runtime.host.store === "function"
          ? () =>
              runtime.host.store(
                entry,
                next,
                this.context(runtime, {
                  confirmed,
                  persist: inner,
                  revert: change.revert,
                }),
              )
          : inner,
      persist,
    );
    await write();
    for (const { runtime, entry } of takers)
      runtime.host.stored?.(
        entry,
        this.context(runtime, { confirmed, persist, revert: change.revert }),
      );
    return this.get();
  }
  /**
   * Sets one described advanced field `fieldId` of runtime `runtimeId`; `value: null`
   * resets it to its default. The runtime's host stores it and takes it as the
   * field's `apply` says (a `restart` field asks first).
   */
  async saveOwn(runtimeId, fieldId, value, { confirmed = false } = {}) {
    const runtime = this.runtimes().find((entry) => entry.id === runtimeId);
    const field = runtime?.fields.find((entry) => entry.id === fieldId);
    if (!field) throw assistantProblem("invalid");
    if (value !== null && !validFieldValue(field, value))
      throw assistantProblem("invalid");
    if (!this.ownStore || typeof runtime.host.storeOwn !== "function")
      throw assistantProblem("advancedSettingUnavailable", 409);
    const next = value === null ? undefined : value;
    const store = this.ownStore;
    const resource = `${runtime.id}.${field.id}`;
    const change = this.change({
      read: () => store.get(runtime.id, field.id),
      write: (to) =>
        to === undefined
          ? store.remove(runtime.id, field.id)
          : store.set(runtime.id, field.id, to),
      // A described field's value is the runtime's own; the audit names the field.
      record: (action, _from, _to, outcome) =>
        this.record(action, resource, { runtime: runtime.id }, outcome),
    });
    await runtime.host.storeOwn(
      field,
      next,
      this.context(runtime, {
        confirmed,
        persist: () => change.persist(next),
        revert: change.revert,
      }),
    );
    return this.get();
  }
  /**
   * One stored value's change: `persist(value)` stores it (`undefined` removes it)
   * and audits the update; `revert()` restores what was stored before, if `persist`
   * ran, and audits that, so the log never claims a value that is no longer stored.
   */
  change({ read, write, record }) {
    let previous = null;
    let stored = false;
    return {
      persist: (value) => {
        previous = read();
        write(value);
        stored = true;
        record("setting.updated", previous?.value, value, "success");
      },
      revert: () => {
        if (!stored) return;
        stored = false;
        const attempted = read()?.value;
        write(previous ? previous.value : undefined);
        record("setting.rolled-back", attempted, previous?.value, "failure");
      },
    };
  }
  // The audit names the setting by id (a path is no audit identifier); its schema
  // keeps the old and new value only as a shared setting's own scalar type.
  record(action, resourceId, details, outcome) {
    try {
      const values = Object.fromEntries(
        Object.entries(details).map(([key, value]) => [key, value ?? null]),
      );
      this.audit?.append({
        action,
        resourceType: "setting",
        resourceId,
        source: "user",
        outcome,
        details: values,
      });
    } catch (error) {
      console.error(`Advanced setting audit ${action} failed:`, error?.message);
    }
  }
}
