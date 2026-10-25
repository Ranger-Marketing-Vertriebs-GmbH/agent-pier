import { legacyAlgorithmsValue } from "./ssh-legacy-algorithms.js";

// Network devices (switches, routers) whose CLI is only an interactive console
// close a connection that asks for a remote command. A host that opts in runs
// every command through that console (ssh-interactive-run.js) over a forced
// pseudo-terminal; it adds `-tt` and `-e none` (typed lines such as `~.` are never
// OpenSSH escapes), never free-form SSH options.

/** Whether a stored SSH host row opted in; rows without the field are off. */
export const usesInteractiveShell = (row) =>
  row?.type !== "sftp" && row?.interactiveShell === true;

/** The OpenSSH arguments of a host in interactive shell mode. */
export const interactiveShellArgs = (row) =>
  usesInteractiveShell(row) ? ["-tt", "-e", "none"] : [];

/**
 * A command for a console, LF line ends: the lines it types. Any other control
 * character (a lone CR, tab, DEL, ESC, ^C, ^U, ^W …) would edit or interrupt the
 * device's line and make the typed text differ from the approved one, so such a
 * command is refused (null) before an approval is requested.
 */
export function consoleCommand(command) {
  const text = String(command).replace(/\r\n/g, "\n");
  return /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text) ? null : text;
}

/** A validated request value: a boolean, or undefined when the request omits it. */
export const interactiveShellValue = legacyAlgorithmsValue;
