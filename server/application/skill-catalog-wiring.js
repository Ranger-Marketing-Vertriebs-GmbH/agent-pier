import path from "node:path";
import { bundledSkillNames } from "../features/assistants/agent-skills.js";
import { shadowingSkillNames } from "../features/assistants/openclaw-config/skill-shadows.js";
import { SkillCatalog } from "../features/skill-catalog/catalog-service.js";
import { SkillCatalogStore } from "../features/skill-catalog/catalog-store.js";

// The source OpenClaw reports for skills from `skills.load.extraDirs`, which holds
// only the catalog root (runtime-config.js).
const catalogReportSource = "openclaw-extra";

/** Skill folders outside any one agent whose names a catalog skill must not reuse. */
export const globalSkillRoots = (root) => [
  path.join(root, "state", "plugin-skills"),
  path.join(root, "state", "skills"),
  path.join(root, "home", ".agents", "skills"),
  path.join(root, "home", ".openclaw", "skills"),
];

/**
 * The names a running Gateway reports from any source other than the catalog; null
 * without a ready Gateway or when it cannot answer (the compile still drops a name it
 * finds shadowed then).
 */
export async function reportedSkillNames(runtime) {
  const client = runtime.client;
  if (!client?.ready) return null;
  let report;
  try {
    report = await client.call("skills.status", {});
  } catch {
    return null;
  }
  return new Set(
    (Array.isArray(report?.skills) ? report.skills : [])
      .filter((skill) => skill?.source !== catalogReportSource)
      .map((skill) => skill?.name)
      .filter((name) => typeof name === "string"),
  );
}

/** Checks every catalog copy; an error is logged by its code only, never thrown. */
export function verifyQuietly(store) {
  try {
    const { failed } = store.verify();
    if (failed.length)
      console.error(`AgentPier could not check ${failed.length} catalog skill(s).`);
  } catch (error) {
    console.error(
      `AgentPier could not check the skill catalog (${error?.code || "no code"}).`,
    );
  }
}

/**
 * Opens the agent skill catalog below the runtime's `skill-catalog` folder, clears what
 * an interrupted write left behind and hands the store to the services that compile
 * and check skills. Every Gateway start verifies the catalog copies before its compile.
 */
export function connectSkillCatalog(graph) {
  const { assistantRuntime: runtime, assistants } = graph;
  const store = new SkillCatalogStore({ root: runtime.paths.skillCatalog });
  try {
    store.sweep();
  } catch (error) {
    // Leftovers stay until the next start; only the stable code is logged.
    console.error(
      `AgentPier could not clean the skill catalog (${error?.code || "no code"}).`,
    );
  }
  assistants.skills.catalog = store;
  assistants.config.skillCatalog = store;
  runtime.skillCatalog = store;
  // Every start checks the catalog copies before it compiles the configuration
  // (teamConfiguration is what the compile reads), so a copy restored or removed here
  // is what the Gateway loads. A failure never stops the start: a skill that could not
  // be checked is in store.failed, and dropped() names it.
  // TODO(Task 6): the compile drops store.dropped(...) names from every agent's list.
  const compileInputs = runtime.teamConfiguration;
  runtime.teamConfiguration = async (...args) => {
    verifyQuietly(store);
    return compileInputs?.(...args);
  };
  return new SkillCatalog({
    store,
    bundledNames: () => bundledSkillNames(runtime.runtime?.entryPath),
    globalNames: () => shadowingSkillNames(globalSkillRoots(runtime.paths.root)),
    reportNames: () => reportedSkillNames(runtime),
  });
}
