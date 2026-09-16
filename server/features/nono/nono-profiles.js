import { execFile } from "node:child_process";

/**
 * `nono profile list` prints a summary line at column 0 ("nono profile: N
 * profiles"), section headings indented by exactly two spaces and ending in a
 * colon ("Built-in:", "Packages:", "User (…):"), and one sandbox profile row
 * per line indented by exactly four spaces. A row is
 * "<name>  <description>  extends <parent>", column-aligned but not
 * fixed-width: a long name pushes the description right, so the sandbox
 * profile name is always the row's first whitespace-delimited token, never a
 * fixed substring. A row whose description begins with "[error:" describes a
 * sandbox profile nono failed to parse and would reject at launch, so it is
 * excluded rather than offered as a choice.
 */
export function parseSandboxProfiles(output) {
  const names = [];
  for (const line of String(output).split("\n")) {
    if (line.slice(0, 4) !== "    " || line[4] === " ") continue;
    const trimmed = line.trim();
    const name = trimmed.split(/\s+/)[0];
    const description = trimmed.slice(name.length).trimStart();
    if (description.startsWith("[error:") || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}
function runNono(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
/**
 * Resolves to the sandbox profiles nono reports. A missing binary or a failing
 * subprocess yields an empty list: the caller decides whether that is fatal.
 */
export async function readSandboxProfiles({ executable, run = runNono }) {
  if (!executable) return [];
  try {
    return parseSandboxProfiles(await run(executable, ["profile", "list", "--silent"]));
  } catch {
    return [];
  }
}
