import test from "node:test";
import assert from "node:assert/strict";

test("slash catalogs use provider-specific names without blocking unknown input", async () => {
  const { builtinSlashCommands, slashMatches } =
    await import("../../web/features/chat/slash-commands.js");
  for (const tool of ["codex", "claude", "opencode"]) {
    const commands = builtinSlashCommands(tool);
    assert.equal(new Set(commands.map((c) => c.name)).size, commands.length);
    assert.ok(slashMatches(commands, "/COM").some((c) => c.name === "compact"));
    for (const value of [
      "/tmp/file",
      "hello /model",
      "/compact args",
      "/model\n",
      "/unknown-native-command",
    ])
      assert.deepEqual(slashMatches(commands, value), []);
  }
  assert.deepEqual(slashMatches(builtinSlashCommands("opencode"), "/mo"), [
    { name: "models" },
  ]);
  assert.deepEqual(builtinSlashCommands("shell"), []);
});
