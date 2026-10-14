import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { toolchainManifest } from "../../server/features/mcp-packages/toolchain-manifest.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
function tarball(root, name) {
  return execFileSync("tar", ["-czf", "-", "-C", root, name]);
}

/**
 * Fake Node, uv and CPython archives whose programs are shell scripts, plus a
 * manifest pinning their checksums. The fake uv installs a fake CPython only from
 * the `file://` mirror AgentPier prepared, as the real one does.
 */
export function toolchainFixture(t, { target = "darwin-arm64" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toolchains-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const source = path.join(root, "source");
  fs.mkdirSync(dataDir);
  const m = toolchainManifest;
  const nodeName = `node-v${m.node.version}-${target}`;
  script(path.join(source, nodeName, "bin/node"), `echo v${m.node.version}`);
  fs.mkdirSync(path.join(source, nodeName, "lib/node_modules/npm/bin"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, nodeName, "lib/node_modules/npm/package.json"),
    JSON.stringify({ version: m.node.npmVersion }),
  );
  fs.writeFileSync(
    path.join(source, nodeName, "lib/node_modules/npm/bin/npm-cli.js"),
    "",
  );
  const uvName = `uv-${m.uv.triples[target]}`;
  const asset = m.python.asset(target);
  script(
    path.join(source, uvName, "uv"),
    [
      `if [ "$1" = "--version" ]; then echo "uv ${m.uv.version} (fixture)"; exit 0; fi`,
      `if [ "$1" = "python" ] && [ "$2" = "install" ]; then`,
      `  [ -f "\${UV_PYTHON_INSTALL_MIRROR#file://}/${m.python.build}/${asset}" ] || exit 3`,
      `  dir="$5/cpython-$3-fixture/bin"; mkdir -p "$dir"`,
      `  printf '#!/bin/sh\\necho "Python %s"\\n' "$3" > "$dir/python3"; chmod +x "$dir/python3"`,
      `  exit 0`,
      `fi`,
      `exit 2`,
    ].join("\n"),
  );
  const bytes = {
    node: tarball(source, nodeName),
    uv: tarball(source, uvName),
    python: Buffer.from("fixture cpython archive"),
  };
  const manifest = {
    ...m,
    node: { ...m.node, checksums: { ...m.node.checksums, [target]: sha(bytes.node) } },
    uv: { ...m.uv, checksums: { ...m.uv.checksums, [target]: sha(bytes.uv) } },
    python: {
      ...m.python,
      checksums: { ...m.python.checksums, [target]: sha(bytes.python) },
    },
  };
  const byUrl = new Map([
    [m.node.url(target), bytes.node],
    [m.uv.url(target), bytes.uv],
    [m.python.url(target), bytes.python],
  ]);
  const downloads = [];
  const download = async (url) => {
    downloads.push(url);
    if (!byUrl.has(url)) throw Object.assign(Error("404"), { status: 404 });
    return byUrl.get(url);
  };
  return { root, dataDir, manifest, download, downloads, bytes, target };
}
