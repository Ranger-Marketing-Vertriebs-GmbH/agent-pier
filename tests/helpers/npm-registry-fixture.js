import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function hostNode() {
  const root = execFileSync("npm", ["root", "-g"]).toString().trim();
  return {
    nodePath: process.execPath,
    npmCliPath: path.join(root, "npm", "bin", "npm-cli.js"),
  };
}

/** A local npm registry: packuments and tarballs for the given packages only. */
export async function npmRegistryFixture(t, packages) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "npm-registry-"));
  const tarballs = new Map();
  const docs = new Map();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    if (tarballs.has(url)) return res.end(tarballs.get(url));
    const doc = docs.get(url.slice(1));
    if (!doc) return res.writeHead(404).end("{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(doc));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  for (const pkg of packages) {
    const dir = path.join(
      work,
      `${pkg.name.replace("/", "__")}-${pkg.version}`,
      "package",
    );
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      ...(pkg.bin ? { bin: pkg.bin } : {}),
      ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    for (const [file, body] of Object.entries(pkg.files || {})) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    }
    const bytes = execFileSync("tar", ["-czf", "-", "-C", path.dirname(dir), "package"]);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const base = pkg.name.split("/").pop();
    const tarPath = `/${pkg.name}/-/${base}-${pkg.version}.tgz`;
    tarballs.set(tarPath, bytes);
    const doc = docs.get(pkg.name) || {
      name: pkg.name,
      "dist-tags": {},
      time: {},
      versions: {},
    };
    doc.versions[pkg.version] = {
      ...manifest,
      dist: { tarball: `${url}${tarPath}`, integrity },
    };
    doc.time[pkg.version] =
      pkg.time ||
      new Date(Date.UTC(2026, 0, Object.keys(doc.versions).length)).toISOString();
    doc["dist-tags"].latest = pkg.version;
    docs.set(pkg.name, doc);
  }
  return {
    url,
    packument: (name) => docs.get(name),
    integrity: (name, version) => docs.get(name).versions[version].dist.integrity,
  };
}
