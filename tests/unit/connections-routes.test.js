import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionsRoute,
  connectionsRoutePath,
  readConnectionsQuery,
} from "../../web/features/connections/routes.js";

test("the tickets category is a connections section", () => {
  assert.deepEqual(readConnectionsQuery("?section=tickets"), { section: "tickets" });
  assert.equal(
    connectionsRoutePath(connectionsRoute("tickets")),
    "/connections?section=tickets",
  );
});
