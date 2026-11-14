import test from "node:test";
import assert from "node:assert/strict";
import { projectAgentBody } from "../../web/features/projects/project-agent-body.js";

test("the project access body sends talk only when known or ticked", () => {
  const older = { coding: false, folder: "none" };
  const choice = { coding: true, folder: "write", sessions: false, talk: false };
  // An older server's row without the switch: nothing about talking is sent.
  assert.deepEqual(projectAgentBody(older, choice), {
    expected: { coding: false, folder: "none" },
    coding: true,
    folder: "write",
    sessions: false,
  });
  // Ticked: sent, with the grant it needs.
  assert.equal(projectAgentBody(older, { ...choice, talk: true }).talk, true);
  // Known: compared and sent; without coding it is never sent on.
  const known = { coding: true, folder: "none", sessions: true, talk: true };
  const body = projectAgentBody(known, { ...choice, coding: false, talk: true });
  assert.deepEqual(body.expected, known);
  assert.equal(body.talk, false);
  assert.equal(projectAgentBody(known, choice).talk, false);
});
