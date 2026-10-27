import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveNpm } from "../../server/features/mcp-packages/npm-package-install.js";
import { ReaTool } from "../../server/features/tools/rea-tool.js";
import { reaManifest } from "../../server/features/tools/rea-manifest.js";
import { run as realRun } from "../../server/features/tools/tool-run.js";
import { packageService, v1 } from "./mcp-packages-service.js";
import { tarGz } from "./tar-fixture.js";

export const fakeBinding = "fake-frida-binding";
export const reaSkillDocument =
  "---\nname: reverse-engineer-anything\ndescription: Reverse engineer anything.\n---\n# Steps\n";
const reaPackage = (version) => ({
  name: "rea-agents",
  version,
  bin: { rea: "scripts/rea.mjs" },
  files: {
    "scripts/rea.mjs": "",
    "skills/reverse-engineer-anything/SKILL.md": reaSkillDocument,
  },
  optionalDependencies: { frida: "17.23.2" },
});
const frida = {
  name: "frida",
  version: "17.23.2",
  type: "module",
  main: "build/src/frida.js",
  exports: { ".": "./build/src/frida.js" },
  files: {
    "build/src/frida.js": `import fs from "node:fs";
const binding = new URL("../frida_binding.node", import.meta.url);
if (fs.readFileSync(binding, "utf8") !== ${JSON.stringify(fakeBinding)}) throw Error("x");
export function getDeviceManager() {}
`,
  },
};
const helper = { name: "helper", version: "1.0.0", files: { "i.js": "" } };
const decompiler = "Ghidra/Features/Decompiler/os/mac_arm_64/decompile";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const ghidraBottle = (version) =>
  tarGz([
    {
      name: `ghidra/${version}/libexec/Ghidra/application.properties`,
      content: `application.version=${version}\n`,
    },
    {
      name: `ghidra/${version}/libexec/${decompiler}`,
      content: "#!/bin/sh\n",
      mode: 0o755,
    },
  ]);
const jdkArchive = (version) =>
  tarGz([
    {
      name: "jdk/Contents/Home/bin/java",
      content: `#!/bin/sh\necho 'OpenJDK Runtime Environment Temurin-${version}' >&2\n`,
      mode: 0o755,
    },
  ]);

/**
 * The managed REA tool over the real server store, central changes and McpPackages
 * (packageService: local npm registry, temporary HOME and data dir). Ghidra, the JDK
 * and frida's prebuild come from a local stand-in for ghcr.io and github.com; nothing
 * reaches the network. The platform is darwin-arm64 on macOS 26.
 */
export async function reaFixture(t) {
  const s = await packageService(t, [
    reaPackage("6.8.0"),
    reaPackage("6.9.0"),
    frida,
    v1,
    helper,
  ]);
  const served = new Map();
  const server = http.createServer((req, res) => {
    const bytes = served.get(req.url);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": bytes.length }).end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const downloads = [];
  const fetchImpl = (url, options) => {
    const target = new URL(url);
    downloads.push(`${target.hostname}${target.pathname}`);
    return fetch(`${local}/${target.hostname}${target.pathname}`, options);
  };
  const serve = (url, bytes) => {
    const target = new URL(url);
    served.set(`/${target.hostname}${target.pathname}`, bytes);
    return { url, sha256: sha(bytes), size: bytes.length };
  };
  const prebuild = serve(
    "https://github.com/frida/frida/releases/download/17.23.2/frida-test.tar.gz",
    tarGz([{ name: "build/frida_binding.node", content: fakeBinding }]),
  );
  /** A manifest pinning these Ghidra and JDK versions, served locally. */
  const manifest = ({ ghidra = "12.1.4", jdk = "21.0.13+9" } = {}) => ({
    ...reaManifest,
    ghidra: {
      version: ghidra,
      platforms: {
        "darwin-arm64": {
          kind: "tar.gz",
          top: "ghidra",
          installDir: `ghidra/${ghidra}/libexec`,
          decompiler,
          installedSize: 1000,
          variants: [
            {
              name: "arm64_tahoe",
              minDarwin: 25,
              auth: "ghcr-anonymous",
              ...serve(
                `https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:${ghidra}`,
                ghidraBottle(ghidra),
              ),
            },
          ],
        },
      },
    },
    jdk: {
      version: jdk,
      platforms: {
        "darwin-arm64": {
          top: "jdk",
          home: "jdk/Contents/Home",
          installedSize: 100,
          ...serve(
            `https://github.com/adoptium/temurin21-binaries/releases/download/${encodeURIComponent(jdk)}/jdk.tar.gz`,
            jdkArchive(jdk),
          ),
        },
      },
    },
    frida: {
      version: "17.23.2",
      napi: 8,
      installedSize: 10,
      platforms: { "darwin-arm64": prebuild },
    },
  });
  // The "committed" lock of `version`, resolved as scripts/refresh-rea-lock.mjs does.
  const core = async (version = "6.8.0") => {
    const stage = fs.mkdtempSync(path.join(s.dataDir, "resolve-"));
    const ref = { registry: "npm", name: "rea-agents", version };
    const { lockText } = await resolveNpm({
      stage,
      ref,
      node: s.node,
      registry: s.registry.url,
      cacheDir: path.join(s.dataDir, "lock-cache"),
      environment: {},
    });
    fs.rmSync(stage, { recursive: true, force: true });
    return {
      ref,
      lockText,
      integrity: s.registry.integrity("rea-agents", version),
      program: { name: "rea", path: "scripts/rea.mjs" },
      args: ["mcp"],
    };
  };
  const run = async (command, args, ...rest) =>
    ["/usr/bin/xattr", "ldd"].includes(command) ? "" : realRun(command, args, ...rest);
  const audits = [];
  const busy = { value: false };
  /** A ReaTool as the wiring builds it, with `afterInstall` hooked into McpPackages. */
  const tool = async ({ pins, coreVersion, ...options } = {}) => {
    const rea = new ReaTool({
      dataDir: s.dataDir,
      servers: s.servers,
      changes: s.changes,
      packages: s.packages,
      extensions: s.extensions,
      audit: { append: (event) => audits.push(event) },
      manifest: manifest(pins),
      core: await core(coreVersion),
      platform: "darwin",
      arch: "arm64",
      darwinMajor: 25,
      fetchImpl,
      run,
      env: {},
      ...options,
    });
    rea.inUse = async () => busy.value;
    s.packages.afterInstall = (serverId, context) => rea.afterInstall(serverId, context);
    t.after(() => rea.close());
    return rea;
  };
  const bindingOf = (serverId) => {
    const row = s.servers.packages.get(serverId);
    return path.join(
      s.dataDir,
      "mcp-packages",
      "installs",
      row.installId,
      "node_modules",
      "frida",
      "build",
      "frida_binding.node",
    );
  };
  const installCount = () => s.calls.filter((args) => args.includes("ci")).length;
  /** Installs REA (Ghidra and frida unless told otherwise) and waits for the job. */
  const install = async (rea, body = {}) => {
    await rea.apply({
      components: { ghidra: true, frida: true },
      confirmInstall: true,
      ...body,
    });
    await rea.settled();
    return rea.state();
  };
  return {
    s,
    tool,
    install,
    manifest,
    fetchImpl,
    run,
    busy,
    audits,
    downloads,
    bindingOf,
    installCount,
    skillCopy: (cli = "claude") =>
      path.join(s.home, `.${cli}`, "skills", "reverse-engineer-anything"),
  };
}
