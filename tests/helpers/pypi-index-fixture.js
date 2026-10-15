import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// A minimal wheel with a correct RECORD, written by the managed CPython's zipfile.
const wheelBuilder = String.raw`
import sys, zipfile, json, hashlib, base64
spec = json.loads(sys.argv[2])
dist = spec["module"] + "-" + spec["version"]
files = {spec["module"] + "/__init__.py": "def main():\n    print('ok')\n"}
meta = "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (spec["name"], spec["version"])
if spec.get("requiresPython"):
    meta += "Requires-Python: %s\n" % spec["requiresPython"]
for dep in spec.get("requires", []):
    meta += "Requires-Dist: %s\n" % dep
files[dist + ".dist-info/METADATA"] = meta
files[dist + ".dist-info/WHEEL"] = "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
if spec.get("script"):
    files[dist + ".dist-info/entry_points.txt"] = "[console_scripts]\n%s = %s:main\n" % (spec["script"], spec["module"])
record = []
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for name, text in files.items():
        data = text.encode()
        z.writestr(name, data)
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append("%s,sha256=%s,%d" % (name, digest, len(data)))
    record.append(dist + ".dist-info/RECORD,,")
    z.writestr(dist + ".dist-info/RECORD", "\n".join(record) + "\n")
`;

// A real setuptools sdist with one C extension and its console scripts (`script` or
// `scripts`).
const sdistBuilder = String.raw`
import sys, tarfile, io, json
spec = json.loads(sys.argv[2])
m, root = spec["module"], spec["module"] + "-" + spec["version"]
c = '''#include <Python.h>
static PyObject* hi(PyObject* s, PyObject* a) { return PyUnicode_FromString("built"); }
static PyMethodDef M[] = {{"hi", hi, METH_NOARGS, ""}, {0}};
static struct PyModuleDef D = {PyModuleDef_HEAD_INIT, "_hello", 0, -1, M};
PyMODINIT_FUNC PyInit__hello(void) { return PyModule_Create(&D); }
'''
files = {
    "PKG-INFO": "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (spec["name"], spec["version"]),
    "pyproject.toml": '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n',
    "setup.py": "from setuptools import setup, Extension\nsetup(name=%r, version=%r, packages=[%r], ext_modules=[Extension(%r, [%r])], entry_points={'console_scripts': %r})\n"
        % (spec["name"], spec["version"], m, m + "._hello", m + "/_hello.c", ["%s = %s:main" % (s, m) for s in spec.get("scripts", [spec.get("script")])]),
    m + "/__init__.py": "from %s._hello import hi\ndef main():\n    print(hi())\n" % m,
    m + "/_hello.c": c,
}
with tarfile.open(sys.argv[1], "w:gz") as tar:
    for name, text in files.items():
        data = text.encode()
        info = tarfile.TarInfo(root + "/" + name)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
`;

function artifact(work, python, pkg) {
  const module = pkg.name.replace(/-/g, "_");
  if (pkg.file)
    return {
      file: pkg.file,
      packagetype: pkg.file.endsWith(".whl") ? "bdist_wheel" : "sdist",
    };
  const sdist = pkg.sdistOnly || pkg.sdist;
  const file = path.join(
    work,
    sdist
      ? `${module}-${pkg.version}.tar.gz`
      : `${module}-${pkg.version}-py3-none-any.whl`,
  );
  if (pkg.sdistOnly) fs.writeFileSync(file, "not a real sdist");
  else
    execFileSync(python.pythonPath, [
      "-I",
      "-c",
      pkg.sdist ? sdistBuilder : wheelBuilder,
      file,
      JSON.stringify({ ...pkg, module }),
    ]);
  return { file, packagetype: sdist ? "sdist" : "bdist_wheel" };
}

/**
 * A PEP 503 simple index plus the PyPI JSON API for `packages`, on 127.0.0.1. A
 * package is `{ name, version, script?, scripts? (sdist), requires?, requiresPython?
 * (wheel metadata), sdistOnly?, sdist?, file? }`.
 * `requests` lists every path served, so a test can prove uv used this index. With
 * `tls: { key, cert }` the index is served over HTTPS.
 */
export async function pypiIndexFixture(t, python, packages, { tls } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pypi-index-"));
  const files = new Map();
  const projects = new Map();
  const requests = [];
  const handler = (req, res) => {
    const url = decodeURIComponent(req.url.split("#")[0].split("?")[0]);
    requests.push(url);
    if (files.has(url)) return res.end(files.get(url));
    const simple = /^\/simple\/([^/]+)\/?$/.exec(url);
    if (simple && projects.has(simple[1])) {
      res.setHeader("content-type", "text/html");
      return res.end(
        `<html><body>${projects.get(simple[1]).links.join("\n")}</body></html>`,
      );
    }
    const json = /^\/pypi\/([^/]+)\/json$/.exec(url);
    if (json && projects.has(json[1])) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(projects.get(json[1]).json));
    }
    res.writeHead(404).end();
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  for (const pkg of packages) {
    const { file, packagetype } = artifact(work, python, pkg);
    const filename = path.basename(file);
    const bytes = fs.readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.set(`/files/${filename}`, bytes);
    const project = projects.get(pkg.name) || {
      links: [],
      json: { info: { version: pkg.version }, releases: {} },
    };
    // PyPI names Requires-Python on the link (PEP 503); uv reads it from there.
    const requiresPython = pkg.requiresPython
      ? ` data-requires-python="${pkg.requiresPython.replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`
      : "";
    project.links.push(
      `<a href="${base}/files/${filename}#sha256=${sha256}"${requiresPython}>${filename}</a>`,
    );
    project.json.info.version = pkg.version;
    project.json.releases[pkg.version] = [
      ...(project.json.releases[pkg.version] || []),
      {
        filename,
        url: `${base}/files/${filename}`,
        digests: { sha256 },
        packagetype,
        upload_time_iso_8601: "2026-10-01T00:00:00Z",
        yanked: false,
        requires_python: pkg.requiresPython ?? ">=3.10",
      },
    ];
    projects.set(pkg.name, project);
  }
  return { api: base, index: `${base}/simple`, requests };
}
