import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";

test("HTTP chat uploads preserve binary data, enforce origin and limits, and are removed with the session", async (t) => {
  const fixture = await applicationFixture(t);
  const session = await fixture.application.sessions.create({
    id: "upload-session",
    name: "Upload fixture",
    tool: "claude",
    accountId: "upload-account",
    cwd: fixture.home,
    command: "/bin/cat",
    args: [],
    env: { PATH: "/usr/bin:/bin", HOME: fixture.home },
  });
  const endpoint = `${fixture.url}/api/sessions/${session.id}/chat/attachments?name=photo.png`;
  const upload = (body, origin = fixture.url) =>
    fetch(endpoint, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/octet-stream" },
      body,
    });
  const body = Buffer.from([0, 255, 137, 80, 78, 71]);
  const denied = await upload(body, "https://untrusted.invalid");
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();
  const response = await upload(body);
  assert.equal(response.status, 201);
  const attachment = await response.json();
  assert.deepEqual(await fs.readFile(attachment.path), body);
  const oversized = await upload(Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  await fixture.application.sessions.stop(session.id);
  const stopped = await upload(body);
  assert.equal(stopped.status, 409);
  await stopped.arrayBuffer();
  const removed = await fetch(`${fixture.url}/api/sessions/${session.id}`, {
    method: "DELETE",
    headers: { Origin: fixture.url },
  });
  assert.equal(removed.status, 204);
  await assert.rejects(fs.stat(attachment.path), { code: "ENOENT" });
});
