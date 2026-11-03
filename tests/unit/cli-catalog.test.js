import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CODING_CLI_IDS,
  cliDefinition,
  cliName,
  codingCliIds,
  isCodingCli,
} from "../../server/features/clis/catalog.js";
import { resumeLaunch } from "../../server/application/session-reload-launch.js";

const FILES = [
  "catalog.js",
  "codex/definition.js",
  "claude/definition.js",
  "opencode/definition.js",
];
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

test("definitions carry every required field", () => {
  assert.deepEqual([...CODING_CLI_IDS], ["codex", "claude", "opencode"]);
  assert.deepEqual(codingCliIds(), [...CODING_CLI_IDS]);
  assert.notEqual(codingCliIds(), codingCliIds());
  for (const id of CODING_CLI_IDS) {
    const d = cliDefinition(id);
    assert.equal(d.id, id);
    assert.ok(isCodingCli(id));
    for (const key of [
      "name",
      "shortName",
      "docsUrl",
      "npmPackage",
      "minVersion",
      "defaultLaunchMode",
      "apiKeyEnv",
    ])
      assert.equal(typeof d[key], "string", `${id}.${key}`);
    assert.ok(["toml", "json", "jsonc"].includes(d.configFormat), `${id}.configFormat`);
    for (const key of ["url", "shell", "directory"])
      assert.equal(typeof d.nativeInstaller[key], "string");
    assert.ok(Array.isArray(d.nativeInstaller.args));
    assert.ok(Array.isArray(d.updateArgs));
    for (const key of ["unattendedModes", "loginArgs", "authStatusArgs"])
      assert.ok(Array.isArray(d[key]), `${id}.${key}`);
    assert.ok(Array.isArray(d.launchModes.default));
    assert.ok(d.defaultLaunchMode in d.launchModes || d.defaultLaunchMode === "default");
    assert.ok(["responses", "messages", "chatCompletions"].includes(d.protocol));
    assert.deepEqual(Object.keys(d.capabilities), [
      "accountTransfer",
      "transcriptCleanup",
      "storageCleanup",
      "mcpOAuth",
      "imagePaste",
      "rateLimits",
    ]);
    for (const value of Object.values(d.capabilities))
      assert.equal(typeof value, "boolean");
    assert.ok(Array.isArray(d.pipeline.permissionModes));
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.launchModes.default));
    assert.ok(Object.isFrozen(d.capabilities) && Object.isFrozen(d.nativeInstaller.args));
  }
  assert.deepEqual(CODING_CLI_IDS.map(cliName), ["Codex", "Claude Code", "OpenCode"]);
  assert.deepEqual(
    CODING_CLI_IDS.map((id) => cliDefinition(id).shortName),
    ["Codex", "Claude", "OpenCode"],
  );
});

test("catalog and definitions import no node modules", () => {
  for (const file of FILES) {
    const source = fs.readFileSync(
      new URL(`../../server/features/clis/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /from\s+["']node:/, file);
    assert.doesNotMatch(source, /\brequire\(|import\(/, file);
    for (const [, spec] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.match(
        spec,
        /^\.\/(?:(codex|claude|opencode)\/)?[\w-]+\.js$/,
        `${file}: ${spec}`,
      );
    }
  }
});

test("capabilities match today's partial lists", () => {
  const caps = (id) => cliDefinition(id).capabilities;
  for (const id of ["codex", "claude"])
    for (const key of ["accountTransfer", "transcriptCleanup", "storageCleanup"])
      assert.equal(caps(id)[key], true);
  for (const key of ["accountTransfer", "transcriptCleanup", "storageCleanup"])
    assert.equal(caps("opencode")[key], false);
  assert.deepEqual(
    CODING_CLI_IDS.filter((id) => caps(id).mcpOAuth),
    ["codex"],
  );
  assert.deepEqual(
    CODING_CLI_IDS.filter((id) => caps(id).imagePaste),
    ["claude"],
  );
  assert.deepEqual(
    CODING_CLI_IDS.filter((id) => caps(id).rateLimits),
    ["codex"],
  );
});

test("resumeArgs reproduce the session reload launch", () => {
  for (const id of CODING_CLI_IDS) {
    const base = { command: "/x", args: ["a"] };
    assert.deepEqual(
      [...base.args, ...cliDefinition(id).resumeArgs(SESSION_ID)],
      resumeLaunch(id, base, SESSION_ID).args,
    );
  }
});

test("unknown id throws", () => {
  for (const id of ["shell", "gh", "nono", "", undefined, "__proto__", "toString"]) {
    assert.equal(isCodingCli(id), false);
    assert.throws(() => cliDefinition(id), TypeError);
  }
});
