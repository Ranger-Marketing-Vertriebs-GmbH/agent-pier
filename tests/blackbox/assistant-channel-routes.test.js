import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
test("channel and speech APIs enforce authentication, origin and secret redaction", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  assert.equal((await fetch(url + "/api/assistant-channels")).status, 401);
  const listed = await fixtureFetch(url + "/api/assistant-channels");
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).channels, []);
  const options = {
    method: "PUT",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "private-speech-key", revision: 0 }),
  };
  const saved = await fixtureFetch(url + "/api/assistant-speech", options);
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes("private-speech-key"));
  assert.equal(
    (
      await fixtureFetch(url + "/api/assistant-speech", {
        ...options,
        headers: { ...options.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
});
