import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultExcludes,
  excluded,
  excludeList,
  isPartFile,
} from "../../server/features/sftp/sftp-excludes.js";

test(".git excludes a/.git/config", () => {
  const list = excludeList();
  assert.deepEqual(list, [".git", ".env", ".env.*"]);
  assert.deepEqual(defaultExcludes, [".git", ".env", ".env.*"]);
  assert.equal(excluded("a/.git/config", list), true);
  assert.equal(excluded(".git", list), true);
  assert.equal(excluded("a/.GIT/config", list), true);
  assert.equal(excluded("a/.github/workflows/ci.yml", list), false);
});

test(".env and .env.* are excluded case-insensitively", () => {
  const list = excludeList();
  for (const name of [".env", "app/.env", ".ENV", ".env.example", "app/.Env.Local"])
    assert.equal(excluded(name, list), true, name);
  for (const name of [".environment", "x.env", "env", ".envrc"])
    assert.equal(excluded(name, list), false, name);
  assert.equal(excluded("A.LOG", excludeList(["*.log"], { defaults: false })), false);
});

test("leftover transfer parts are recognised", () => {
  assert.equal(isPartFile(".index.html.agentpier-part-0123456789abcdef"), true);
  assert.equal(isPartFile("index.html"), false);
  assert.equal(isPartFile(".agentpier-part-00"), false);
});

test("dist/*.map", () => {
  const list = excludeList(["dist/*.map"], { defaults: false });
  assert.equal(excluded("dist/app.js.map", list), true);
  assert.equal(excluded("dist/app.js", list), false);
  assert.equal(excluded("dist/sub/app.js.map", list), false);
  assert.equal(excluded("src/dist/app.js.map", list), false);
  assert.equal(excluded("dist/x.ma", excludeList(["dist/x.m?"])), true);
});

test("**/cache", () => {
  const list = excludeList(["**/cache"], { defaults: false });
  assert.equal(excluded("cache", list), true);
  assert.equal(excluded("a/b/cache", list), true);
  assert.equal(excluded("a/b/cache/file.bin", list), true);
  assert.equal(excluded("a/cached", list), false);
  assert.equal(excluded("a/x/b", excludeList(["a/**/b"], { defaults: false })), true);
  assert.equal(excluded("a/b", excludeList(["a/**/b"], { defaults: false })), true);
  assert.equal(excluded("node_modules/x", excludeList(["/node_modules/"])), true);
});

test("defaults: false", () => {
  const list = excludeList(["*.log"], { defaults: false });
  assert.deepEqual(list, ["*.log"]);
  assert.equal(excluded(".git/config", list), false);
  assert.equal(excluded("logs/today.log", list), true);
  assert.equal(excluded("today.logs", list), false);
});

test("invalid exclude lists are refused", () => {
  const refused = { code: "SFTP_PATH_REFUSED" };
  assert.throws(() => excludeList("*.log"), refused);
  assert.throws(() => excludeList([""]), refused);
  assert.throws(() => excludeList(["a\nb"]), refused);
  assert.throws(() => excludeList(["a\\b"]), refused);
  assert.throws(() => excludeList(["x".repeat(201)]), refused);
  assert.throws(
    () => excludeList(Array.from({ length: 51 }, (_, i) => `p${i}`)),
    refused,
  );
  assert.throws(() => excludeList(["../x"]), refused);
});

test("pathological patterns stay fast", () => {
  const pattern = "*a".repeat(90) + "b";
  const list = excludeList([pattern, "**/".repeat(60) + "z"], { defaults: false });
  const name = "a".repeat(250);
  const started = performance.now();
  assert.equal(excluded(Array.from({ length: 16 }, () => name).join("/"), list), false);
  assert.ok(performance.now() - started < 500);
});
