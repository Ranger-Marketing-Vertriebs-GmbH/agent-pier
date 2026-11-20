// Pure rules of Agents › Runtime › Advanced (docs/adr/0007-runtime-descriptor.md):
// what the page says about the runtimes the server lists (`data.runtimes`, the
// default first, each `{ id, name, shortName, process, enabled, running, version,
// qualified, agents, own }`) and about each shared setting (`setting.runtimes`: how
// each runtime that takes it does, `{ apply, available, current }`). No runtime is
// named here; the texts take the runtimes' names (assistant-advanced catalogs).
import { ownKey } from "./runtime-draft.js";

// A runtime the page speaks about beside the first: switched on, with agents.
const present = (runtime) => runtime.enabled && runtime.agents > 0;

/**
 * The notes above the settings, in order. The first runtime's host is the agent
 * service when it is shared by all its agents: `unqualified` (its `version` is not
 * approved for the settings) or `stopped`. Every further runtime that is on and has
 * agents: `applies` (settings without "`only` only" also reach `name` agents) or
 * `otherUnqualified` (`product` `version` is not approved; `name` agents keep their
 * defaults).
 */
export function advancedNotes(data) {
  const [first, ...further] = data?.runtimes || [];
  if (!first) return [];
  const notes = [];
  if (first.process === "shared") {
    if (!first.qualified) notes.push({ kind: "unqualified", version: first.version });
    else if (!first.running) notes.push({ kind: "stopped" });
  }
  for (const runtime of further.filter(present))
    notes.push(
      runtime.qualified
        ? { kind: "applies", only: first.shortName, name: runtime.shortName }
        : {
            kind: "otherUnqualified",
            product: runtime.name,
            version: runtime.version,
            name: runtime.shortName,
          },
    );
  return notes;
}

/**
 * How the row of shared `setting` reads: `taken`, how the first listed runtime that
 * takes it does (its badge and whether it can be changed), and `pills` about the
 * other runtimes that are on and have agents: one `only` (`name` agents alone take
 * it; `other` agents keep their default) when some of them lack it, and a `restart`
 * per runtime whose agents restart to take a change. With a `restart` pill, `name`
 * is the first runtime's, whose agents the badge speaks of.
 */
export function settingScope(data, setting) {
  const runtimes = data?.runtimes || [];
  const takes = (runtime) => setting.runtimes?.[runtime.id];
  const main = runtimes.find(takes);
  const taken = main ? takes(main) : (Object.values(setting.runtimes || {})[0] ?? null);
  const pills = [];
  for (const runtime of runtimes.filter((entry) => entry !== main && present(entry))) {
    const entry = takes(runtime);
    if (!entry) {
      if (main && !pills.some((pill) => pill.kind === "only"))
        pills.push({ kind: "only", name: main.shortName, other: runtime.shortName });
    } else if (entry.available && entry.apply === "restart")
      pills.push({ kind: "restart", name: runtime.shortName });
  }
  // Beside a pill that restarts another runtime's agents, the badge names whose it
  // is ("Immediate for OpenClaw"), so the row does not read as both at once.
  const named = main && pills.some((pill) => pill.kind === "restart");
  return { taken, pills, ...(named && { name: main.shortName }) };
}

/**
 * The rows of described surface `surface` of the list entry `runtime`: for each field
 * this build has texts for (`copyOf(fieldId)`), the field as the settings answer
 * describes it (`data.runtimes[].own`, with its stored value), its draft `key` and
 * its `text`. [] until the settings are read.
 */
export function ownRows(data, runtime, surface, copyOf) {
  const entry = (data?.runtimes || []).find(({ id }) => id === runtime.id);
  const known = new Map((entry?.own || []).map((field) => [field.id, field]));
  return (surface?.fields || []).flatMap(({ id }) => {
    const text = copyOf(id);
    return known.has(id) && text?.label
      ? [{ field: known.get(id), key: ownKey(runtime.id, id), text }]
      : [];
  });
}

/**
 * Every runtime's own described field the page can show (`copyOf(runtimeId,
 * fieldId)` has texts for it): `[{ runtime, field, key, text }]`, `runtime` its id.
 */
export const ownList = (data, copyOf) =>
  (data?.runtimes || []).flatMap((runtime) =>
    (runtime.own || []).flatMap((field) => {
      const text = copyOf(runtime.id, field.id);
      return text?.label
        ? [{ runtime: runtime.id, field, key: ownKey(runtime.id, field.id), text }]
        : [];
    }),
  );
