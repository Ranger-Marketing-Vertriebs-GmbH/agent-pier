import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionsRoute,
  connectionsRoutePath,
  readConnectionsQuery,
} from "../../web/features/connections/routes.js";
import { routePath } from "../../web/app/routes.js";

test("the tickets category is a connections section", () => {
  assert.deepEqual(readConnectionsQuery("?section=tickets"), { section: "tickets" });
  assert.equal(
    connectionsRoutePath(connectionsRoute("tickets")),
    "/connections?section=tickets",
  );
});

test("a provider connection link can name one model row", () => {
  const route = {
    view: "connections",
    section: "models",
    item: "c1",
    model: "gpt-4o/prod:1",
  };
  const path = connectionsRoutePath(route);
  assert.equal(path, "/connections?section=models&item=c1&model=gpt-4o%2Fprod%3A1");
  assert.deepEqual(readConnectionsQuery(path.slice("/connections".length)), {
    section: "models",
    item: "c1",
    model: "gpt-4o/prod:1",
  });
  // Only an existing connection has model rows; invalid ids are dropped.
  assert.deepEqual(readConnectionsQuery("?section=models&item=new&model=x"), {
    section: "models",
    item: "new",
  });
  assert.deepEqual(readConnectionsQuery("?section=models&item=c1&model=..%2F a"), {
    section: "models",
    item: "c1",
  });
  assert.deepEqual(readConnectionsQuery("?section=services&item=speech&model=x"), {
    section: "services",
    item: "speech",
  });
});

test("the old accounts address keeps the model of a connection link", () => {
  assert.equal(
    routePath({ view: "accounts", section: "models", item: "c1", model: "prod" }),
    "/connections?section=models&item=c1&model=prod",
  );
});
