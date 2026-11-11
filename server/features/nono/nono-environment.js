/**
 * nono resolves its own folders from the XDG variables of the environment it is
 * started with: its state under `$XDG_STATE_HOME/nono` (sessions, audit, rollbacks;
 * `~/.local/state/nono` when unset) and its configuration, with the operator's
 * sandbox profiles, under `$XDG_CONFIG_HOME/nono` (`~/.config/nono`). It protects the
 * state root: a grant on it, below it or on a folder that contains it is refused
 * ("Refusing to grant … because it overlaps protected nono state root …", nono 0.79.0
 * and 0.81.0; `nono profile guide`, "Protected nono state roots"). It also expands
 * `$XDG_*` in a profile's paths from the same environment.
 *
 * A managed OpenCode account points all four XDG base directories (cache, config,
 * data, state) into its account folder, which the launch grants. nono started with
 * them would place its state inside that grant and refuse the launch, and would look
 * for the chosen sandbox profile in the account folder ("Profile not found"). So
 * these variables never reach nono: it runs with the environment of a launch without
 * an account folder, and its state stays outside everything the session may touch.
 */
// Every XDG base directory variable a launch sets, whichever CLI's account sets it.
const BASE_DIRECTORY_VARIABLE = /^XDG_[A-Z]+_HOME$/;

/** Sets variables for the program it execs into; nono has no flag for that. */
export const ENVIRONMENT_PROGRAM = "/usr/bin/env";

/**
 * Splits a launch's environment into what nono is started with (`outer`) and the
 * assignments only the CLI gets, in a stable order.
 */
export function separateEnvironment(env = {}) {
  const outer = { ...env };
  const assignments = [];
  for (const name of Object.keys(env).sort()) {
    if (!BASE_DIRECTORY_VARIABLE.test(name) || typeof env[name] !== "string") continue;
    assignments.push(`${name}=${env[name]}`);
    delete outer[name];
  }
  return { outer, assignments };
}

/**
 * The CLI's command line inside the sandbox. With assignments it is started through
 * `env`, which execs into it, so the process stays the CLI itself. `env` reads every
 * leading word with an equals sign as a variable, a program's path included; such a
 * path is handed to a shell that execs it instead.
 */
export function cliCommand(launch, assignments) {
  const cli = [launch.command, ...(launch.args || [])];
  if (!assignments.length) return cli;
  return [
    ENVIRONMENT_PROGRAM,
    ...assignments,
    ...(launch.command.includes("=") ? ["/bin/sh", "-c", 'exec "$0" "$@"'] : []),
    ...cli,
  ];
}
