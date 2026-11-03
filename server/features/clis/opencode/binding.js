// How the native session binding hooks into OpenCode: a TUI plugin that may report
// before OpenCode has a session id.
import path from "node:path";

/** The TUI plugin may record a launch before OpenCode names its session. */
export const idOptional = true;

/**
 * Writes `<directory>/<id>.tui.json` loading the `pluginUrl` TUI plugin with
 * `write(file, value)` and points OPENCODE_TUI_CONFIG at it. A launch that already
 * sets OPENCODE_TUI_CONFIG fails with `fail("temporaryTuiConfigConflict")`.
 */
export function addHooks(launch, { id, directory, pluginUrl, write, fail }) {
  const { env } = launch;
  if (env.OPENCODE_TUI_CONFIG) throw fail("temporaryTuiConfigConflict");
  const config = path.join(directory, `${id}.tui.json`);
  write(config, { plugin: [pluginUrl] });
  env.OPENCODE_TUI_CONFIG = config;
}
