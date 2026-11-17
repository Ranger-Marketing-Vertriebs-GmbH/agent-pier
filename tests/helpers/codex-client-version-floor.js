import fs from "node:fs";
import path from "node:path";

/**
 * The oldest Codex client version OpenClaw may send as `client_version` when it
 * discovers ChatGPT-account models: older clients are not offered GPT-6.2-Astra.
 * The installed package must reach it whether upstream ships it or AgentPier's
 * `codex-catalog-client-version` patch does (runtime-bundle-patches.js), so a pin
 * bump that would silently drop the patch fails until it is carried forward.
 */
export const codexClientVersionFloor = "0.169.0";

const parts = (version) => version.split(".").map(Number);

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b` (x.y.z). */
export function compareVersions(a, b) {
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

const patterns = [
  /OPENAI_CODEX_CLIENT_VERSION\s*=\s*["'`]([^"'`]+)["'`]/g,
  /client_version=(\d+\.\d+\.\d+)/g,
];

function* scripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(file);
    else if (entry.isFile() && /\.(m?js|cjs)$/.test(entry.name)) yield file;
  }
}

/**
 * Every Codex client version literal in the package's `dist` (the
 * `OPENAI_CODEX_CLIENT_VERSION` constant and literal `client_version=` queries), as
 * `{ file, version }` with `file` relative to `packageDir`.
 */
export function codexClientVersions(packageDir) {
  const found = [];
  for (const file of scripts(path.join(packageDir, "dist"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("CODEX_CLIENT_VERSION") && !text.includes("client_version="))
      continue;
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern))
        found.push({
          file: path.relative(packageDir, file).split(path.sep).join("/"),
          version: match[1],
        });
  }
  return found;
}

/**
 * Throws unless the package names a Codex client version and every one is at least
 * `floor`. Finding none fails too: upstream may have moved the constant, and the
 * guard must then be updated rather than pass silently.
 */
export function assertCodexClientVersionFloor(
  packageDir,
  floor = codexClientVersionFloor,
) {
  const found = codexClientVersions(packageDir);
  if (!found.some((item) => item.file.includes("base-url")))
    throw Error(
      `No OPENAI_CODEX_CLIENT_VERSION found in ${packageDir}/dist; update the Codex client version guard.`,
    );
  const old = found.filter(
    (item) =>
      !/^\d+\.\d+\.\d+$/.test(item.version) || compareVersions(item.version, floor) < 0,
  );
  if (old.length)
    throw Error(
      `OpenClaw asks the Codex model catalog as a client older than ${floor}: ${old
        .map((item) => `${item.file} (${item.version})`)
        .join(
          ", ",
        )}. Carry the codex-catalog-client-version patch forward (runtime-bundle-patches.js).`,
    );
  return found;
}
