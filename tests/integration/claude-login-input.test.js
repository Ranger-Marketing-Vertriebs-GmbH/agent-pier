import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";

test("manual login code reaches a native no-echo prompt through the owner input API", async (t) => {
  const fixture = await applicationFixture(t);
  const session = await fixture.application.sessions.create({
    id: randomUUID(),
    name: "Synthetic login",
    tool: "claude",
    purpose: "login",
    accountId: "local-claude",
    cwd: fixture.home,
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `import readline from 'node:readline'; process.stdin.setRawMode(true); readline.createInterface({input:process.stdin}).on('line',line=>{console.log(line==='synthetic-code#state'?'LOGIN_INPUT_ACCEPTED':'INVALID_INPUT');}); console.log('Paste code here if prompted > ');`,
    ],
    env: { PATH: process.env.PATH, HOME: fixture.home },
  });
  async function screenContaining(marker) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const screen = await fixture.application.sessions.screen(session.id);
      if (screen.includes(marker)) return screen;
      await pause(40);
    }
    assert.fail(`Native fixture did not report ${marker}`);
  }
  await screenContaining("Paste code here");
  const response = await fixture.request(`/api/sessions/${session.id}/input`, {
    method: "POST",
    body: { text: "synthetic-code#state", submit: true },
  });
  assert.equal(response.status, 200);
  const screen = await screenContaining("LOGIN_INPUT_ACCEPTED");
  assert.ok(!screen.includes("synthetic-code#state"));
});
