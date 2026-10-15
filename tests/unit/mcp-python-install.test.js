import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileFailure,
  installPython,
  resolvePython,
  uvEnvironment,
} from "../../server/features/mcp-packages/python-package-install.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const python = { uvPath: "/tc/uv/uv", pythonPath: "/tc/cpython/bin/python3" };
const ref = { registry: "pypi", name: "srv-x", version: "1.0" };
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-uv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const failure = (stderr) => Object.assign(Error("uv"), { stdout: "", stderr });
const writeLock = (args, text) => fs.writeFileSync(args[args.indexOf("-o") + 1], text);

test("the uv environment is built from scratch; compilers only with the opt-in", (t) => {
  const dir = tmp(t);
  const options = {
    work: dir,
    index: "https://pypi.org/simple",
    cacheDir: path.join(dir, "cache"),
    environment: {
      HTTPS_PROXY: "http://proxy:3128",
      UV_INDEX_URL: "https://evil",
      UV_EXTRA_INDEX_URL: "https://evil",
      PIP_INDEX_URL: "x",
      PATH: "/evil/bin",
      HOME: "/Users/owner",
    },
  };
  const env = uvEnvironment({ ...options, allowScripts: false });
  assert.equal(env.UV_INDEX_URL, "https://pypi.org/simple");
  assert.equal(env.UV_NO_CONFIG, "1");
  assert.equal(env.UV_PYTHON_DOWNLOADS, "never");
  assert.equal(env.UV_LINK_MODE, "copy");
  assert.equal(env.UV_CACHE_DIR, path.join(dir, "cache"));
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, path.join(dir, "home"));
  assert.equal(env.TMPDIR, path.join(dir, "tmp"));
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.UV_EXTRA_INDEX_URL, undefined);
  assert.equal(env.CC, undefined);
  assert.equal(env.CXX, undefined);
  for (const name of ["home", "tmp", "cache"])
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o700, name);
  const build = uvEnvironment({ ...options, allowScripts: true });
  assert.equal(build.CC, "cc");
  assert.equal(build.CXX, "c++");
});

test("uv gets SSL_CERT_FILE only when the owner configured a CA for Node", (t) => {
  const work = tmp(t);
  const extra = path.join(work, "company.pem");
  fs.writeFileSync(extra, "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n");
  const base = { work, index: "https://pypi.org/simple", cacheDir: path.join(work, "c") };
  assert.equal(uvEnvironment({ ...base, environment: {} }).SSL_CERT_FILE, undefined);
  const env = uvEnvironment({ ...base, environment: { NODE_EXTRA_CA_CERTS: extra } });
  assert.equal(path.dirname(env.SSL_CERT_FILE), work);
  assert.match(
    fs.readFileSync(env.SSL_CERT_FILE, "utf8"),
    /-----BEGIN CERTIFICATE-----\nX\n/,
  );
  assert.equal(env.UV_NATIVE_TLS, undefined);
});

test("the CA bundle goes away with the uv work folder", async (t) => {
  const stage = tmp(t);
  const extra = path.join(tmp(t), "company.pem");
  fs.writeFileSync(extra, "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n");
  let bundle;
  await resolvePython({
    stage,
    ref,
    python,
    index: "http://i/simple",
    cacheDir: path.join(tmp(t), "c"),
    environment: { NODE_EXTRA_CA_CERTS: extra },
    execute: async (file, args, options) => {
      bundle = options.env.SSL_CERT_FILE;
      assert.ok(fs.existsSync(bundle));
      writeLock(args, "srv-x==1.0 \\\n    --hash=sha256:x\n");
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(path.dirname(bundle), path.join(stage, ".uv-work"));
  assert.equal(fs.existsSync(bundle), false);
});

test("a wheel-only resolve compiles once, hashed, headerless, for the managed Python", async (t) => {
  const stage = tmp(t);
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, options });
    writeLock(args, "srv-x==1.0 \\\n    --hash=sha256:x\n");
    return { stdout: "", stderr: "" };
  };
  const result = await resolvePython({
    stage,
    ref,
    python,
    index: "http://i/simple",
    cacheDir: path.join(tmp(t), "c"),
    allowScripts: false,
    execute,
    environment: { UV_INDEX_URL: "https://evil" },
  });
  assert.equal(result.needsScripts, false);
  assert.equal(result.requirementsText, "srv-x==1.0\n");
  assert.match(result.lockText, /^srv-x==1\.0/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, python.uvPath);
  const { args, options } = calls[0];
  for (const flag of [
    "compile",
    "--generate-hashes",
    "--no-header",
    "--no-annotate",
    "--only-binary",
    ":all:",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--only-binary") + 1], ":all:");
  // uv refuses `--no-build` next to `--only-binary`; the stored lock must not name
  // an index or build options.
  for (const flag of ["--no-build", "--emit-index-url", "--emit-build-options"])
    assert.equal(args.includes(flag), false, flag);
  assert.equal(args[args.indexOf("--python") + 1], python.pythonPath);
  assert.equal(options.env.UV_INDEX_URL, "http://i/simple");
  assert.equal(options.env.UV_NO_CONFIG, "1");
  assert.equal(options.cwd, path.join(stage, ".uv-work"));
  assert.deepEqual(fs.readdirSync(stage), []);
});

test("no usable wheels: needs scripts; built only with the opt-in", async (t) => {
  const noWheel = failure(
    "Because old-x==1.0 has no usable wheels and you require old-x==1.0 …\nhint: Wheels are required for `old-x`",
  );
  let calls = 0;
  const execute = async (file, args) => {
    calls += 1;
    if (args.includes("--only-binary")) throw noWheel;
    writeLock(args, "old-x==1.0 \\\n    --hash=sha256:y\n");
    return { stdout: "", stderr: "" };
  };
  const base = { ref, python, index: "http://i/simple", execute, environment: {} };
  const refused = await resolvePython({
    ...base,
    stage: tmp(t),
    cacheDir: tmp(t),
    allowScripts: false,
  });
  assert.deepEqual([refused.needsScripts, refused.lockText, calls], [true, null, 1]);
  const built = await resolvePython({
    ...base,
    stage: tmp(t),
    cacheDir: tmp(t),
    allowScripts: true,
  });
  assert.equal(built.needsScripts, true);
  assert.match(built.lockText, /^old-x==1\.0/);
});

test("a wrapped no-usable-wheels message still means the package needs a build", async (t) => {
  const execute = async () => {
    throw failure(
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because a-very-long-distribution-name-for-wrapping==1.0 has no usable\n      wheels and you require it, we can conclude …",
    );
  };
  const result = await resolvePython({
    stage: tmp(t),
    ref,
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    allowScripts: false,
    execute,
    environment: {},
  });
  assert.deepEqual([result.needsScripts, result.lockText], [true, null]);
});

test("any other compile failure is an install failure without uv output", async (t) => {
  const stage = tmp(t);
  const logged = [];
  const execute = async () => {
    throw failure(
      `Because the current Python version (3.14.7) does not satisfy Python>=3.15 … ${stage}`,
    );
  };
  const error = await resolvePython({
    stage,
    ref,
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    allowScripts: false,
    execute,
    environment: {},
    log: (text) => logged.push(text),
  }).catch((caught) => caught);
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(error.status, 502);
  assert.equal(error.message.includes(stage), false);
  assert.equal(error.message.includes("Python>=3.15"), false);
  assert.match(logged.join("\n"), /Python>=3\.15/);
  assert.deepEqual(fs.readdirSync(stage), []);
});

test("a failed build compile with the opt-in is an install failure", async (t) => {
  const execute = async (file, args) => {
    if (args.includes("--only-binary")) throw failure("old-x has no usable wheels");
    throw failure("error: Failed to build `old-x==1.0`");
  };
  await assert.rejects(
    resolvePython({
      stage: tmp(t),
      ref,
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts: true,
      execute,
      environment: {},
    }),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("a missing uv binary is an install failure", async (t) => {
  const execute = async () => {
    throw Object.assign(Error("spawn /tc/uv/uv ENOENT"), { code: "ENOENT" });
  };
  await assert.rejects(
    resolvePython({
      stage: tmp(t),
      ref,
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts: false,
      execute,
      environment: {},
    }),
    (error) =>
      error.code === "MCP_PACKAGE_INSTALL_FAILED" && !/\/tc\//.test(error.message),
  );
});

test("install creates a relocatable venv and syncs the lock with hashes", async (t) => {
  const directory = path.join(tmp(t), ".stage-x");
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ file, args, env: options.env, cwd: options.cwd });
    return { stdout: "", stderr: "" };
  };
  const base = {
    directory,
    requirementsText: "srv-x==1.0\n",
    lockText: "lock\n",
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    execute,
    environment: {},
  };
  await installPython({ ...base, allowScripts: false });
  assert.equal(calls[0].file, python.uvPath);
  assert.deepEqual(calls[0].args, [
    "venv",
    "--relocatable",
    "--python",
    python.pythonPath,
    path.join(directory, "venv"),
  ]);
  assert.deepEqual(calls[1].args.slice(0, 3), [
    "pip",
    "sync",
    path.join(directory, "requirements.lock"),
  ]);
  for (const flag of ["--require-hashes", "--only-binary", ":all:"])
    assert.ok(calls[1].args.includes(flag), flag);
  assert.equal(calls[1].args.includes("--no-build"), false);
  assert.equal(
    calls[1].args[calls[1].args.indexOf("--python") + 1],
    path.join(directory, "venv", "bin", "python"),
  );
  assert.equal(calls[1].env.CC, undefined);
  assert.equal(calls[1].cwd, path.join(directory, ".uv-work"));
  assert.equal(
    fs.readFileSync(path.join(directory, "requirements.lock"), "utf8"),
    "lock\n",
  );
  assert.equal(
    fs.readFileSync(path.join(directory, "requirements.in"), "utf8"),
    "srv-x==1.0\n",
  );
  assert.equal(fs.existsSync(path.join(directory, ".uv-work")), false);
  calls.length = 0;
  await installPython({
    ...base,
    directory: path.join(tmp(t), ".stage-y"),
    allowScripts: true,
  });
  assert.equal(calls[1].args.includes("--only-binary"), false);
  assert.ok(calls[1].args.includes("--require-hashes"));
  assert.equal(calls[1].env.CC, "cc");
  assert.equal(calls[1].env.CXX, "c++");
});

test("a failed venv or sync is an install failure and leaves no work folder", async (t) => {
  for (const failing of ["venv", "sync"]) {
    const directory = path.join(tmp(t), ".stage");
    const logged = [];
    const execute = async (file, args) => {
      if (args.includes(failing)) throw failure(`raw uv output ${directory}`);
      return { stdout: "", stderr: "" };
    };
    const error = await installPython({
      directory,
      requirementsText: "srv-x==1.0\n",
      lockText: "lock\n",
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts: false,
      execute,
      environment: {},
      log: (text) => logged.push(text),
    }).catch((caught) => caught);
    assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED", failing);
    assert.equal(error.message.includes(directory), false, failing);
    assert.match(logged.join("\n"), /raw uv output/, failing);
    assert.equal(fs.existsSync(path.join(directory, ".uv-work")), false, failing);
  }
});

test("constraints narrow both compiles through a constraints file", async (t) => {
  const seen = [];
  const execute = async (file, args) => {
    assert.ok(args.includes("--no-annotate") && args.includes("--no-header"));
    const at = args.indexOf("-c");
    seen.push(fs.readFileSync(args[at + 1], "utf8"));
    assert.equal(path.basename(args[at + 1]), "constraints.txt");
    assert.equal(fs.statSync(args[at + 1]).mode & 0o777, 0o600);
    if (args.includes("--only-binary"))
      throw failure("old-x has no usable wheels\nhint: Wheels are required for `old-x`");
    writeLock(args, "srv-x==1.0 \\\n    --hash=sha256:x\n");
    return { stdout: "", stderr: "" };
  };
  const stage = tmp(t);
  const result = await resolvePython({
    stage,
    ref,
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    allowScripts: true,
    constraints: ["fastmcp<4", "httpx==0.28.*"],
    execute,
    environment: {},
  });
  assert.equal(result.needsScripts, true);
  assert.deepEqual(seen, ["fastmcp<4\nhttpx==0.28.*\n", "fastmcp<4\nhttpx==0.28.*\n"]);
  // The constraints narrow the resolve only; the input stays the top package.
  assert.equal(result.requirementsText, "srv-x==1.0\n");
  assert.deepEqual(fs.readdirSync(stage), []);
});

test("without constraints no constraints file is passed", async (t) => {
  const execute = async (file, args) => {
    assert.equal(args.includes("-c"), false);
    writeLock(args, "srv-x==1.0 \\\n    --hash=sha256:x\n");
    return { stdout: "", stderr: "" };
  };
  await resolvePython({
    stage: tmp(t),
    ref,
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    allowScripts: false,
    constraints: [],
    execute,
    environment: {},
  });
});

// uv 0.12.21 without a terminal (verified against the managed toolchain): "error: No
// solution found when resolving dependencies" plus "cause:" lines; on a terminal "×"/"╰─▶".
test("a failed compile is a needed build, a Python mismatch, an unsatisfiable graph or another failure", () => {
  assert.equal(
    compileFailure(
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because x==1.0 has no\n      usable wheels and you require x==1.0, we can conclude",
    ),
    "build",
  );
  assert.equal(
    compileFailure(
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because only helper-x<=2.0 is available and srv-y==1.0 depends on helper-x>=3",
    ),
    "unsatisfiable",
  );
  assert.equal(
    compileFailure(
      "error: No solution found when resolving dependencies\n  cause: Because there is no version of helper-x==9.0 and srv-x==1.0 depends on helper-x==9.0",
    ),
    "unsatisfiable",
  );
  for (const cause of [
    "Because srv-top==1.0 requires Python >=3.99 and you require srv-top==1.0",
    "Because the current Python version (3.14.7) does not satisfy Python>=3.15 and srv-x==1.0 depends on Python>=3.15",
  ])
    assert.equal(
      compileFailure(
        `error: No solution found when resolving dependencies\n  cause: ${cause}`,
      ),
      "python",
    );
  assert.equal(
    compileFailure("error: Failed to fetch: `http://127.0.0.1:1/simple/x/`"),
    "failed",
  );
  assert.equal(compileFailure("Python>=3.15 without a resolver report"), "failed");
});

test("an unsatisfiable resolve is named as such, with or without the build", async (t) => {
  const conflict =
    "  × No solution found when resolving dependencies:\n  ╰─▶ Because only helper-x<=2.0 is available and srv-x==1.0 depends on helper-x>=3";
  const python314 =
    "error: No solution found when resolving dependencies\n  cause: Because srv-x==1.0 requires Python >=3.15 and you require srv-x==1.0";
  const cases = [
    [conflict, "unsatisfiable"],
    [python314, "pythonUnsupported"],
  ];
  for (const [output, message] of cases)
    for (const allowScripts of [false, true]) {
      const logged = [];
      const error = await resolvePython({
        stage: tmp(t),
        ref,
        python,
        index: "http://i/simple",
        cacheDir: tmp(t),
        allowScripts,
        constraints: ["helper-x<3"],
        execute: async () => {
          throw failure(output);
        },
        environment: {},
        log: (text) => logged.push(text),
      }).catch((caught) => caught);
      assert.equal(error.code, "MCP_PACKAGE_UNSATISFIABLE");
      assert.equal(error.status, 400);
      assert.equal(error.message, serverMessages.mcpPackages[message]);
      // The resolver report stays in the log; the answer carries none of it.
      assert.doesNotMatch(error.message, /helper-x|srv-x|Because/);
      assert.match(logged.join("\n"), /Because/);
    }
});

test("a build compile that is unsatisfiable after the missing wheel is named as such", async (t) => {
  const execute = async (file, args) => {
    if (args.includes("--only-binary")) throw failure("old-x has no usable wheels");
    throw failure(
      "error: No solution found when resolving dependencies\n  cause: Because only helper-x<=2.0 is available and old-x==1.0 depends on helper-x>=3",
    );
  };
  await assert.rejects(
    resolvePython({
      stage: tmp(t),
      ref,
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts: true,
      execute,
      environment: {},
    }),
    { code: "MCP_PACKAGE_UNSATISFIABLE" },
  );
});
