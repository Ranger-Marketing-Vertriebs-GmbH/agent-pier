import { CraftTool } from "../features/tools/craft-tool.js";
import { craftJobChanged, reaJobChanged } from "../features/tools/live-topics.js";
import { craftRebuildsChanged } from "../features/craft/live-topics.js";
import { createReaTool, managedRowInUse } from "./rea-wiring.js";

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
  sessions,
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
  // Running rebuilds count too: their children and builders run Craft Anything. A
  // child no running rebuild uses (a view opened it) never blocks a change: once
  // nothing else uses Craft Anything, it is closed here, before the change starts.
  craft.inUse = async () => {
    const rebuilds = services()?.craftRebuilds;
    if (rebuilds?.inUse()) return true;
    const used = await managedRowInUse({
      serverId: craft.serverId(),
      servers,
      sessions,
      assistants: services()?.assistants,
    });
    if (!used) await rebuilds?.closeIdle();
    return used;
  };
  return craft;
}

/** The other tool wants, runs or changes the Ghidra and JDK both tools share. */
function join(one, other) {
  one.keepsGhidra = () => other.wantsGhidra();
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
