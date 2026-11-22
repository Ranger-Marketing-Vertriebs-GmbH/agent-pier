import fs from "node:fs";
import path from "node:path";

/**
 * After a Doctor migration OpenClaw prepares agents one by one once the Gateway
 * listens. A concurrent model runtime refresh, such as `models.authRefresh`, makes an
 * agent's publication throw `PreparedModelRuntimePublicationSupersededError`; the
 * startup loop (agent-database-startup-*.mjs) retries only its own
 * `AgentDatabaseStartupSupersededError`. 2026.11.3 let the first escape, and the agent
 * stayed degraded until the Gateway restarted (AgentPier patched the loop then).
 * Since 2026.11.6 the Gateway's `publishAgent` turns a plugin lifecycle failure,
 * that refusal included, into `AgentDatabaseStartupSupersededError`, which the loop
 * retries. This guard reads the installed package, so a pin bump that drops the
 * conversion fails until AgentPier patches the retry again.
 */
const lifecycle =
  /function isPreparedModelRuntimePluginLifecycleFailure\(\w+\) \{\s*return ([^}]*)\}/g;
const conversion =
  /if \(!isPreparedModelRuntimePluginLifecycleFailure\((\w+)\)\) throw \1;[^}]{0,120}?throw new AgentDatabaseStartupSupersededError\(/g;
const loop =
  /(\w+) instanceof AgentDatabaseStartupSupersededError[^;]*;\s*if \(![\w$]+ \|\| [\w$]+ >= STARTUP_PUBLICATION_ATTEMPTS\)/g;

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/**
 * Where the package `dist` classifies plugin lifecycle failures (`lifecycle`, with
 * `superseded` whether a superseded publication counts as one), converts them for the
 * startup loop (`conversion`) and retries that loop (`loop`), each `{ file, … }` with
 * `file` relative to `packageDir`.
 */
export function supersededPublicationSites(packageDir) {
  const found = { lifecycle: [], conversion: [], loop: [] };
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    const relative = path.relative(packageDir, file).split(path.sep).join("/");
    if (text.includes("function isPreparedModelRuntimePluginLifecycleFailure("))
      for (const [, body] of text.matchAll(lifecycle))
        found.lifecycle.push({
          file: relative,
          superseded: body.includes(
            "instanceof PreparedModelRuntimePublicationSupersededError",
          ),
        });
    if (text.includes("publishAgent"))
      for (const _ of text.matchAll(conversion))
        found.conversion.push({ file: relative });
    if (text.includes("STARTUP_PUBLICATION_ATTEMPTS"))
      for (const _ of text.matchAll(loop)) found.loop.push({ file: relative });
  }
  return found;
}

/**
 * Throws unless a superseded startup publication reaches the startup loop as the
 * refusal it retries. Finding any part missing fails: upstream may have renamed or
 * moved it, and the guard (or a patch) must then be updated rather than pass silently.
 */
export function assertSupersededPublicationRetried(packageDir) {
  const found = supersededPublicationSites(packageDir);
  const fail = (detail) =>
    Error(
      `OpenClaw may leave an agent degraded when a concurrent refresh supersedes its startup publication: ${detail} in ${packageDir}/dist. Patch the startup retry again (runtime-bundle-patches.js) or update the superseded publication guard.`,
    );
  if (!found.lifecycle.length) throw fail("no plugin lifecycle failure check");
  if (found.lifecycle.some((site) => !site.superseded))
    throw fail("a superseded publication is no plugin lifecycle failure");
  if (!found.conversion.length) throw fail("publishAgent converts no lifecycle failure");
  if (!found.loop.length) throw fail("no startup publication retry");
  return found;
}
