import test from "node:test";
import assert from "node:assert/strict";
import {
  interactionWindow,
  recentlyUsedElsewhere,
} from "../../web/features/requests/request-interaction.js";

test("a request touched elsewhere counts its age from when the list arrived", () => {
  const entry = { interaction: { client: "other", age: 1000 }, receivedAt: 0 };
  assert.equal(recentlyUsedElsewhere(entry, 1000), true);
  assert.equal(recentlyUsedElsewhere(entry, interactionWindow - 1001), true);
  assert.equal(recentlyUsedElsewhere(entry, interactionWindow - 1000), false);
  assert.equal(recentlyUsedElsewhere(entry, interactionWindow + 5000), false);
});

test("without a stamp the server's age alone counts", () => {
  const fresh = { interaction: { client: "other", age: 1000 } };
  assert.equal(recentlyUsedElsewhere(fresh, Number.MAX_SAFE_INTEGER), true);
  const old = { interaction: { client: "other", age: interactionWindow } };
  assert.equal(recentlyUsedElsewhere(old), false);
  assert.equal(recentlyUsedElsewhere({ receivedAt: 0 }, 0), false);
});
