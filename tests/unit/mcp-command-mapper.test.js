import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  mapCommand,
  npmSpec,
  pypiSpec,
  splitCommandLine,
} from "../../web/features/mcp-servers/wizard/command-mapper.js";

const codes = (notes) => notes.map((note) => note.code);

test("npx, bunx, pnpm dlx and yarn dlx become npm packages", () => {
  const npx = mapCommand("npx", ["-y", "@scope/pkg@latest", "--port", "3000"]);
  assert.equal(npx.kind, "npm");
  assert.equal(npx.packageName, "@scope/pkg");
  assert.equal(npx.version, "");
  assert.deepEqual(npx.args, ["--port", "3000"]);
  assert.deepEqual(codes(npx.ignored), ["runner", "yes"]);
  assert.deepEqual(codes(npx.warnings), ["pinned"]);
  const exact = mapCommand("bunx", ["server-x@1.2.3"]);
  assert.equal(exact.version, "1.2.3");
  assert.deepEqual(exact.warnings, []);
  assert.equal(mapCommand("pnpm", ["dlx", "server-x"]).kind, "npm");
  assert.equal(mapCommand("yarn", ["dlx", "server-x@^1"]).version, "");
  const program = mapCommand("npx", ["-p", "@scope/tools@2.0.0", "tool-a", "--x"]);
  assert.deepEqual(
    [program.packageName, program.version, program.program, program.args],
    ["@scope/tools", "2.0.0", "tool-a", ["--x"]],
  );
  assert.equal(mapCommand("npx", ["--package=server-x", "serve"]).program, "serve");
  assert.equal(mapCommand("/usr/local/bin/npx", ["-q", "server-x"]).kind, "npm");
});

test("uvx, uv tool run and pipx run become PyPI packages", () => {
  const uvx = mapCommand("uvx", ["mcp-server-fetch==2025.4.7", "--ignore-robots-txt"]);
  assert.deepEqual(
    [uvx.kind, uvx.packageName, uvx.version, uvx.args],
    ["pypi", "mcp-server-fetch", "2025.4.7", ["--ignore-robots-txt"]],
  );
  assert.equal(mapCommand("uvx", ["pkg@1.0"]).version, "1.0");
  assert.equal(mapCommand("uvx", ["pkg>=1.0"]).version, "");
  const from = mapCommand("uvx", ["--from", "pkg==0.4.1", "prog", "--flag"]);
  assert.deepEqual(
    [from.packageName, from.version, from.program, from.args],
    ["pkg", "0.4.1", "prog", ["--flag"]],
  );
  const resolver = mapCommand("uvx", ["--with", "extra", "--python", "3.12", "pkg"]);
  assert.deepEqual(codes(resolver.ignored), ["runner", "resolverFlag", "resolverFlag"]);
  const extras = mapCommand("uvx", ["pkg[cli]==1.0"]);
  assert.equal(extras.packageName, "pkg");
  assert.deepEqual(codes(extras.warnings), ["extras"]);
  assert.equal(mapCommand("uv", ["tool", "run", "pkg"]).kind, "pypi");
  assert.equal(mapCommand("pipx", ["run", "pkg"]).packageName, "pkg");
  const spec = mapCommand("pipx", ["run", "--spec", "pkg==1.0", "prog"]);
  assert.deepEqual([spec.packageName, spec.program], ["pkg", "prog"]);
});

test("cmd /c is unwrapped; docker stays an own command with a warning", () => {
  const wrapped = mapCommand("cmd", ["/c", "npx", "-y", "server-x"]);
  assert.equal(wrapped.kind, "npm");
  assert.deepEqual(codes(wrapped.ignored), ["cmdWrapper", "runner", "yes"]);
  const docker = mapCommand("docker", ["run", "-i", "--rm", "mcp/fetch"]);
  assert.deepEqual(
    [docker.kind, docker.command, docker.args],
    ["command", "docker", ["run", "-i", "--rm", "mcp/fetch"]],
  );
  assert.deepEqual(codes(docker.warnings), ["docker"]);
  assert.equal(mapCommand("podman", ["run"]).warnings[0].code, "docker");
  const own = mapCommand("node", ["/srv/server.js"]);
  assert.deepEqual(
    [own.kind, own.command, own.args],
    ["command", "node", ["/srv/server.js"]],
  );
});

test("a runner without a valid package name stays an own command", () => {
  for (const args of [[], ["-y"], ["Not A Name!"], ["../evil"]]) {
    const mapped = mapCommand("npx", args);
    assert.equal(mapped.kind, "command", JSON.stringify(args));
    assert.equal(mapped.command, "npx");
    assert.deepEqual(mapped.args, args);
  }
});

test("package specs keep a scope's @ and split PEP 440 versions", () => {
  assert.deepEqual(npmSpec("@a/b@1.0.0"), { name: "@a/b", version: "1.0.0" });
  assert.deepEqual(npmSpec("@a/b"), { name: "@a/b", version: "" });
  assert.deepEqual(pypiSpec("pkg[x,y] == 1.0"), {
    name: "pkg",
    version: "1.0",
    extras: true,
  });
  assert.deepEqual(pypiSpec("pkg~=1.0"), {
    name: "pkg",
    version: "~=1.0",
    extras: false,
  });
});

test("only versions the install route accepts are preselected", () => {
  assert.equal(mapCommand("npx", ["pkg@01.0.0"]).version, "");
  assert.equal(mapCommand("uvx", ["pkg==1!2.0"]).version, "1!2.0");
  assert.equal(mapCommand("npx", [`${"a".repeat(215)}@1.0.0`]).kind, "command");
});

test("command lines split on spaces with quotes; shell operators are refused", () => {
  assert.deepEqual(splitCommandLine("npx -y \"my pkg\" 'a b'"), [
    "npx",
    "-y",
    "my pkg",
    "a b",
  ]);
  assert.deepEqual(splitCommandLine('uvx pkg ""'), ["uvx", "pkg", ""]);
  for (const line of [
    "",
    "a | b",
    "a && b",
    "a; b",
    "a > f",
    "echo `x`",
    "a $(b)",
    'a "open',
    "a\nb",
  ])
    assert.equal(splitCommandLine(line), null, line);
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => {
      const words = splitCommandLine(text);
      assert.ok(words === null || words.every((word) => typeof word === "string"));
    }),
  );
});
