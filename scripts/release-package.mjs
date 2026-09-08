import { isMainModule } from "../server/lib/is-main-module.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  packageRelease,
  unpackRelease,
  smokeRelease,
} from "../server/features/operations/release-archive.js";
import { readFile } from "../server/features/operations/files.js";
import { prepareReleaseRuntime } from "../server/features/operations/release-runtime.js";

function validateOutput(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.nlink !== 1)
      throw Error("Release output must be an absent path or a regular unlinked file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function publish(archive, output, result) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  const metadata = `${output}.json.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(archive, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    fs.writeFileSync(metadata, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    validateOutput(output);
    validateOutput(`${output}.json`);
    fs.renameSync(temporary, output);
    fs.renameSync(metadata, `${output}.json`);
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(metadata, { force: true });
  }
}

export async function buildRelease({
  source,
  output,
  node,
  nodeLicense,
  prepareDependencies = true,
}) {
  source = fs.realpathSync(source);
  if (typeof output !== "string" || !output || /[\x00-\x1f]/.test(output))
    throw Error("A release output file path is required.");
  // A declared output parent may use a system alias such as macOS /tmp. It is not private application storage.
  output = path.join(
    fs.realpathSync(path.dirname(path.resolve(output))),
    path.basename(output),
  );
  validateOutput(output);
  validateOutput(`${output}.json`);
  if (!fs.existsSync(path.join(source, "dist/index.html")))
    throw Error("Build the web application before packaging.");
  const stage = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-package-")),
  );
  const smoke = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-package-smoke-")),
  );
  const runtime = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-runtime-")),
  );
  try {
    node ||= await prepareReleaseRuntime(runtime);
    for (const name of [
      "server",
      "vendor",
      "dist",
      "scripts",
      "package.json",
      "package-lock.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ])
      fs.cpSync(path.join(source, name), path.join(stage, name), { recursive: true });
    if (prepareDependencies)
      execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: stage,
        stdio: "inherit",
        env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH}` },
      });
    else
      fs.cpSync(path.join(source, "node_modules"), path.join(stage, "node_modules"), {
        recursive: true,
        dereference: false,
      });
    const version = JSON.parse(fs.readFileSync(path.join(stage, "package.json"))).version;
    const archive = path.join(runtime, path.basename(output));
    const result = packageRelease({
      source: stage,
      node,
      nodeLicense,
      output: archive,
      version,
    });
    fs.rmSync(stage, { recursive: true, force: true });
    unpackRelease(readFile(archive, 768 * 1024 * 1024), smoke);
    await smokeRelease(smoke);
    publish(archive, output, result);
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(smoke, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url)) {
  const source = path.resolve(import.meta.dirname, ".."),
    output = path.resolve(
      process.argv[2] || `agentpier-${process.platform}-${process.arch}.aprelease`,
    );
  const result = await buildRelease({ source, output });
  console.log(JSON.stringify(result, null, 2));
}
