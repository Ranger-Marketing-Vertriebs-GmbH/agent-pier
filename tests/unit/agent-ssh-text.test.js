import test from "node:test";
import assert from "node:assert/strict";
import * as server from "../../server/features/assistants/agent-ssh-text.js";
import * as web from "../../web/features/assistants/ssh-command-text.js";

test("server and web treat the same characters as hidden", () => {
  assert.equal(server.hiddenCharacterSource, web.hiddenCharacterSource);
  for (const ch of [
    "‮",
    "​",
    "⁦",
    "﻿",
    "\u0007",
    "\r",
    "\u0085",
    "\u{E0041}",
    "\u2028",
    "\u2029",
    "\uFE0F",
    "\u{E0100}",
    "\u034F",
    "\u115F",
    "\u1160",
    "\u3164",
    "\uFFA0",
    "\u17B4",
    "\uFFF9",
  ]) {
    assert.equal(server.hasHiddenCharacters(`ls${ch}`), true, ch.codePointAt(0));
    assert.equal(web.hasHiddenCharacters(`ls${ch}`), true, ch.codePointAt(0));
  }
  for (const text of ["ls -la\n\tpwd", "echo é ü 你好", ""]) {
    assert.equal(server.hasHiddenCharacters(text), false);
    assert.equal(web.hasHiddenCharacters(text), false);
  }
});

test("the preview is the first line, at most 80 code points", () => {
  assert.equal(server.commandPreview("uptime"), "uptime");
  assert.equal(server.commandPreview("tail -f log\nrm x"), "tail -f log…");
  const long = "x".repeat(200);
  assert.equal(Array.from(server.commandPreview(long)).length, 80);
  assert.ok(server.commandPreview(long).endsWith("…"));
  assert.equal(Array.from(server.commandPreview("😀".repeat(100))).length, 80);
  const exact = "y".repeat(80);
  assert.equal(server.commandPreview(exact), exact);
  assert.equal(server.commandPreview(`${exact}\nz`), `${"y".repeat(79)}…`);
  assert.equal(server.commandPreview(`${"y".repeat(81)}`), `${"y".repeat(79)}…`);
  assert.equal(server.commandPreview("ab\r\ncd"), "ab…");
});

test("the digest is the SHA-256 of the exact UTF-8 bytes", () => {
  assert.match(server.commandDigest("uptime"), /^[a-f0-9]{64}$/);
  assert.notEqual(server.commandDigest("uptime"), server.commandDigest("uptime "));
});

test("segments escape hidden characters as codes", () => {
  assert.deepEqual(web.commandSegments("ls‮-la"), [
    { text: "ls" },
    { hidden: "‮", code: "U+202E" },
    { text: "-la" },
  ]);
  assert.equal(web.visibleCommand("a​b"), "a[U+200B]b");
  assert.equal(web.commandLines("a\nb\nc"), 3);
  assert.equal(web.characterCode("\u{E0041}"), "U+E0041");
  assert.equal(web.characterCode("\u0007"), "U+0007");
  assert.equal(web.visibleCommand("a\u2028b"), "a[U+2028]b");
});

test("a note's command keeps at most 8 KiB without splitting a character", () => {
  assert.deepEqual(server.noteCommand("uptime"), { command: "uptime" });
  assert.deepEqual(server.noteCommand(undefined), {});
  const exact = "x".repeat(8192);
  assert.deepEqual(server.noteCommand(exact), { command: exact });
  const long = server.noteCommand(`${"é".repeat(5000)}`);
  assert.equal(long.commandCut, true);
  assert.ok(Buffer.byteLength(long.command) <= 8192);
  assert.equal(long.command, "é".repeat(4096));
  const emoji = server.noteCommand("😀".repeat(3000));
  assert.equal(emoji.command, "😀".repeat(2048));
});
