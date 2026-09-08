import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
test("ordinary Chat and model controls cannot type into a pending native request", async (t) => {
  const f = await applicationFixture(t);
  let inputs = 0;
  f.application.requests.list = async () => ({
    requests: [{ id: "pending", status: "pending" }],
  });
  f.application.sessions.input = async () => {
    inputs++;
  };
  f.application.models.open = async () => {
    inputs++;
    return {};
  };
  for (const [endpoint, body] of [
    ["input", { text: "yes", submit: true }],
    ["models/open", {}],
  ]) {
    const response = await f.request(`/api/sessions/fixture/${endpoint}`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 409);
  }
  assert.equal(inputs, 0);
});
