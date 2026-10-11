import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
test("web search API is owner-only, origin-checked and never returns keys", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  assert.equal((await fetch(url + "/api/assistant-web-search")).status, 401);
  const initial = await fixtureFetch(url + "/api/assistant-web-search");
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).provider, "duckduckgo");
  const options = {
    method: "PUT",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      revision: 0,
      provider: "brave",
      braveKey: "private-brave-key",
    }),
  };
  const saved = await fixtureFetch(url + "/api/assistant-web-search", options);
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.ok(!text.includes("private-brave-key"));
  assert.equal(JSON.parse(text).hasBraveKey, true);
  const read = await (await fixtureFetch(url + "/api/assistant-web-search")).text();
  assert.ok(!read.includes("private-brave-key"));
  const stale = await fixtureFetch(url + "/api/assistant-web-search", options);
  assert.equal(stale.status, 409);
  assert.ok(!(await stale.text()).includes("private-brave-key"));
  assert.equal(
    (
      await fixtureFetch(url + "/api/assistant-web-search", {
        ...options,
        headers: { ...options.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
});
