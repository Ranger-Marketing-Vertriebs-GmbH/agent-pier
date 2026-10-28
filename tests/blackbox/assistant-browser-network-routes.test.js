import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

test("only the owner can save the browser network policy; origin, revision and audit are enforced", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const route = "/api/assistant-browser-network";
  assert.equal((await fetch(f.url + route)).status, 401);
  assert.deepEqual(await (await f.request(route)).json(), {
    revision: 0,
    allowPrivateNetwork: false,
    active: null,
  });
  const { cookie } = await signedInUser(f);
  const body = { revision: 0, allowPrivateNetwork: true };
  for (const method of ["GET", "PUT"])
    assert.equal(
      (
        await f.request(route, {
          method,
          headers: { cookie },
          ...(method === "PUT" && { body }),
        })
      ).status,
      404,
    );
  assert.equal(
    (await f.request(route, { method: "PUT", body, origin: "https://foreign.invalid" }))
      .status,
    403,
  );
  const saved = await f.request(route, { method: "PUT", body });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.equal((await saved.json()).allowPrivateNetwork, true);
  assert.equal((await f.request(route, { method: "PUT", body })).status, 409);
  assert.equal(
    (
      await f.request(route, {
        method: "PUT",
        body: { revision: 1, allowPrivateNetwork: "true" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(route, {
        method: "PUT",
        body: { revision: 1, allowPrivateNetwork: false },
      })
    ).status,
    200,
  );
  const events = f.application.audit
    .list({})
    .events.filter((event) => event.resourceId === "browser-private-network");
  assert.deepEqual(events.map((event) => event.action).sort(), [
    "setting.activated",
    "setting.revoked",
  ]);
});
