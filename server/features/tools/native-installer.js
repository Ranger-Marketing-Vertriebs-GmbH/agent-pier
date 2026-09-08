import fs from "node:fs/promises";
import path from "node:path";
import { problem } from "../../lib/storage.js";

export const nativeInstallers = {
  codex: {
    url: "https://chatgpt.com/codex/install.sh",
    shell: "/bin/sh",
    args: [],
    directory: ".local/bin",
  },
  claude: {
    url: "https://claude.ai/install.sh",
    shell: "/bin/bash",
    args: [],
    directory: ".local/bin",
  },
  opencode: {
    url: "https://opencode.ai/install",
    shell: "/bin/bash",
    args: ["--no-modify-path"],
    directory: ".opencode/bin",
  },
};
export function nativeDestination(home, tool) {
  return path.join(home, nativeInstallers[tool].directory);
}
const bootstrapRedirects = {
  codex: "https://releases.openai.com/codex/install.sh",
  claude: "https://downloads.claude.ai/claude-code-releases/bootstrap.sh",
  opencode: "https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/dev/install",
};
export async function downloadNativeScript(tool, fetchImpl, signal) {
  const allowed = new Set([nativeInstallers[tool].url, bootstrapRedirects[tool]]);
  let url = nativeInstallers[tool].url;
  let response;
  for (let redirects = 0; redirects < 5; redirects++) {
    response = await fetchImpl(url, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get("location"), url).href;
    await response.body?.cancel();
    if (!allowed.has(next))
      throw problem("Native installer redirect is not an official bootstrap URL.", 409);
    url = next;
  }
  if (!response.ok)
    throw problem(`Native installer download failed (HTTP ${response.status}).`, 409);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024)
        throw problem("Native installer exceeds its download limit.", 409);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const script = Buffer.concat(chunks);
  if (!script.length || !script.subarray(0, 100).toString().startsWith("#!"))
    throw problem("The official native installer response is not a shell script.", 409);
  return script;
}
export async function installNative({
  tool,
  home,
  work,
  env,
  signal,
  timeout,
  fetchImpl,
  run,
}) {
  const spec = nativeInstallers[tool];
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const script = await downloadNativeScript(tool, fetchImpl, combined);
  const file = path.join(work, "native-install.sh");
  await fs.writeFile(file, script, { mode: 0o600, flag: "wx" });
  const destination = nativeDestination(home, tool);
  const nativeEnv = {
    ...env,
    HOME: home,
    PATH: `${destination}${path.delimiter}${env.PATH}`,
  };
  // Native updaters must see the same host HOME as later managed account launches.
  delete nativeEnv.DISABLE_AUTOUPDATER;
  delete nativeEnv.OPENCODE_DISABLE_AUTOUPDATE;
  await run(spec.shell, [file, ...spec.args], nativeEnv, work, combined, timeout);
  const binary = path.join(destination, tool);
  const real = await fs.realpath(binary);
  const root = await fs.realpath(home);
  if (!real.startsWith(root + path.sep))
    throw problem(
      "The native installer did not create a binary inside the server home.",
      409,
    );
  const output = await run(binary, ["--version"], env, work, signal, 15000);
  if (!/\b\d+\.\d+(?:\.\d+)?\b/.test(output) || output.length > 512)
    throw problem("The native CLI version check failed.", 409);
  return output.trim().split("\n")[0];
}
