import { CraftTool } from "../features/tools/craft-tool.js";
import { craftJobChanged, reaJobChanged } from "../features/tools/live-topics.js";
import { craftRebuildsChanged } from "../features/craft/live-topics.js";
import { createReaTool } from "./rea-wiring.js";

/**
 * The managed Craft Anything tool on the central MCP server store, or null without
 * the store. `services()` is read lazily: agents start after this.
 */
export function createCraftTool({
  config,
  servers,
  changes,
  packages,
  extensions,
  audit,
  services,
}) {
  if (!servers || !packages) return null;
  const craft = new CraftTool({
    dataDir: config.dataDir,
    servers,
    changes,
    packages,
    extensions,
    audit,
  });
  // In use means work in flight: a running or starting rebuild, or a call of its Craft
  // Anything. A session's or an agent's idle MCP server never counts (AgentPier sees
  // no call in flight there): it keeps its version until it reloads. A rebuild child
  // no running rebuild uses (a view opened it) is closed here, before the change.
  craft.inUse = async () => {
    const rebuilds = services()?.craftRebuilds;
    if (rebuilds?.inUse()) return true;
    await rebuilds?.closeIdle();
    return false;
  };
  return craft;
}

/** The other tool wants, runs or changes the Ghidra and JDK both tools share. */
function join(one, other) {
  one.keepsGhidra = () => other.wantsGhidra();
  // Only Craft Anything's rebuilds count: a session's idle server keeps its version
  // folder (VersionSweep), so replacing or removing Ghidra never breaks it.
  one.othersUseGhidra = async () => (await other.inUse()) && other.wantsGhidra();
  one.othersBusy = () => !!other.job || other.claimed;
}

/**
 * `tool`'s onChange: signals its live topic and, once a job of it ended (an install,
 * update or removal may have placed, replaced or kept the shared Ghidra), brings the
 * other tool's row and config in line. Never throws.
 */
function followJobs(tool, signal, other) {
  let running = false;
  return () => {
    signal();
    const now = !!tool.job;
    if (running && !now && other)
      Promise.resolve()
        .then(() => other.syncEnvironment())
        .catch((error) =>
          console.error(
            `AgentPier could not update a managed tool's environment: ${error?.code || error?.message || "unknown error"}`,
          ),
        );
    running = now;
  };
}

/**
 * Joins REA and Craft Anything (either may be null): the shared Ghidra hooks both
 * ways while both exist, and each one's live topic on `live()` (services.live).
 */
export function joinManagedTools({ rea, craft, live }) {
  if (rea && craft) {
    join(rea, craft);
    join(craft, rea);
  }
  if (rea) rea.onChange = followJobs(rea, () => reaJobChanged(live()), craft);
  // Craft Anything's install state is part of the rebuild list (`installed`).
  const craftChanged = () => {
    craftJobChanged(live());
    craftRebuildsChanged(live());
  };
  if (craft) craft.onChange = followJobs(craft, craftChanged, rea);
}

/** REA and Craft Anything, joined; both null without the MCP server store. */
export function createManagedTools(options) {
  const rea = createReaTool(options);
  const craft = createCraftTool(options);
  joinManagedTools({ rea, craft, live: () => options.services?.()?.live });
  return { rea, craft };
}

/** The managed rows' CLI bindings changed: each tool's skill copies follow, in turn. */
export async function managedBindingsChanged(services) {
  await services.rea?.bindingsChanged();
  await services.craft?.bindingsChanged();
}
