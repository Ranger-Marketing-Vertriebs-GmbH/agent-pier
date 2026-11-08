import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { hermesManifest } from "./hermes-manifest.js";
import { hermesExecutables } from "./hermes-paths.js";
import { privateFolder } from "../../runtime-paths.js";

// PDFium for AgentPier's pdf tool of a Hermes agent (hermes-config/pdf.js): the
// pypdfium2 wheel the manifest pins for the platform, checked against its SHA-256 and
// installed into the installation's virtual environment with its own uv, without
// dependencies (it has none) or an index. Hermes's lock does not name it, so an
// installation built before it gets it at the next staging (hermes-provisioning.js
// hermesStagingDue), as agent-browser does; the pdf tool imports it at each call, so
// running agents need no restart.

const failure = (code) => Object.assign(Error(code), { code });
const markerOf = (directory) =>
  path.join(hermesExecutables(directory).tools, "pdfium.json");

/** The wheel `manifest` pins for `target` ("darwin-arm64", …), or null. */
export const pdfiumWheel = (manifest, target) =>
  manifest.pdfium?.wheels?.[target] ?? null;

/** Whether the installation in `directory` holds the pypdfium2 `manifest` pins. */
export function hasPdfium(
  directory,
  manifest = hermesManifest,
  target = `${process.platform}-${process.arch}`,
) {
  const wheel = pdfiumWheel(manifest, target);
  return !!wheel && readJSON(markerOf(directory), null)?.sha256 === wheel.sha256;
}

/**
 * Installs the pinned pypdfium2 into the installation in `directory`. `run(file,
 * args, options)` runs uv and the installation's Python with the installation's
 * environment (hermes-install.js hermesInstallEnvironment); `scratch` holds the
 * downloaded wheel. Idempotent: a matching installation stays.
 */
export async function installPdfium(
  directory,
  { manifest = hermesManifest, target, download, run, scratch },
) {
  const wheel = pdfiumWheel(manifest, target);
  if (!wheel) throw failure("HERMES_PLATFORM_UNSUPPORTED");
  if (hasPdfium(directory, manifest, target)) return;
  const bytes = await download(wheel.url);
  if (createHash("sha256").update(bytes).digest("hex") !== wheel.sha256)
    throw failure("HERMES_CHECKSUM_MISMATCH");
  // uv reads the platform and version from the wheel's own file name.
  const file = path.join(scratch, path.basename(new URL(wheel.url).pathname));
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const { python, uv, tools } = hermesExecutables(directory);
  await run(uv, [
    "pip",
    "install",
    "--python",
    python,
    "--no-deps",
    "--no-index",
    "--no-cache",
    file,
  ]);
  await run(python, ["-I", "-c", "import pypdfium2"]);
  privateFolder(tools);
  writePrivate(markerOf(directory), {
    version: manifest.pdfium.version,
    sha256: wheel.sha256,
  });
}
