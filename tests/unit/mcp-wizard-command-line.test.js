import test from "node:test";
import assert from "node:assert/strict";
import {
  commandArguments,
  commandLine,
  environmentNames,
  shellWord,
} from "../../web/features/mcp-servers/wizard/command-line.js";

test("the command line names the command and every argument", () => {
  assert.equal(
    commandLine("/usr/local/bin/node", ["/home/me/mcp/echo.mjs", "--port", "8080"]),
    "/usr/local/bin/node /home/me/mcp/echo.mjs --port 8080",
  );
  assert.equal(commandLine("uvx", []), "uvx");
});

test("arguments with spaces, quotes or shell characters read back unchanged", () => {
  assert.equal(shellWord("a b"), "'a b'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
  assert.equal(shellWord("$(rm -rf ~)"), "'$(rm -rf ~)'");
  assert.equal(shellWord("--flag=value"), "--flag=value");
  assert.equal(
    commandLine("node", ["/tmp/my script.js", "", "--x"]),
    "node '/tmp/my script.js' --x",
  );
});

test("empty argument rows are dropped exactly as the save drops them", () => {
  assert.deepEqual(commandArguments(["", "--a", "", "b"]), ["--a", "b"]);
});

test("environment settings are named without their values", () => {
  const names = environmentNames([
    { name: "API_TOKEN", value: "secret-value" },
    { name: " KEPT ", value: "", stored: true },
    { name: "GONE", value: "x", removed: true },
    { name: "EMPTY", value: "" },
    { name: "", value: "orphan" },
  ]);
  assert.deepEqual(names, ["API_TOKEN", "KEPT"]);
  assert.ok(!JSON.stringify(names).includes("secret-value"));
});
