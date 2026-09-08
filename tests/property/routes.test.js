import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readRoute, routePath } from "../../web/app/routes.js";
import { check, publicId } from "../helpers/property.js";

const parse = (pathname) => readRoute(new URL(pathname, "https://agentpier.test"));

test("generated public session and profile routes round-trip without changing identity", () => {
  check(
    fc.property(publicId, fc.constantFrom(null, "reader", "terminal"), (id, mode) => {
      const route = { view: "workspace", sessionId: id, mode };
      assert.deepEqual(parse(routePath(route)), route);
      for (const view of ["extensions", "plugins"]) {
        assert.deepEqual(parse(routePath({ view, profileId: id })), {
          view,
          profileId: id,
        });
      }
      assert.deepEqual(parse(`/sessions/${id}/reader`), {
        ...route,
        mode: "reader",
      });
    }),
  );
});

test("generated AgentBus history links retain the project and pagination independently", () => {
  check(
    fc.property(publicId, fc.integer({ min: 1, max: 10000 }), (id, page) => {
      const route = {
        view: "agentbus",
        busTab: "messages",
        projectId: id,
        messagePage: page,
      };
      assert.deepEqual(parse(routePath(route)), route);
    }),
  );
});

test("encoded separators, control characters and invalid leading symbols cannot create a valid session route", () => {
  const invalid = fc.oneof(
    publicId.map((id) => `../${id}`),
    publicId.map((id) => `${id}/terminal`),
    publicId.map((id) => `-${id}`),
    publicId.map((id) => `${id}\u0000`),
    publicId.map((id) => `${id}\\other`),
  );
  check(
    fc.property(invalid, (id) => {
      // A Location-like object avoids URL normalization before the application parser runs.
      assert.equal(
        readRoute({ pathname: `/sessions/${encodeURIComponent(id)}/chat` }).view,
        "missing",
      );
      assert.equal(
        readRoute({ pathname: "/", hash: `#${encodeURIComponent(id)}` }).view,
        "missing",
      );
    }),
  );
});

test("generated memory links retain repository scope, Unicode search, archive and page", () => {
  check(
    fc.property(
      publicId,
      fc.string({ unit: "grapheme", maxLength: 30 }),
      fc.boolean(),
      fc.integer({ min: 1, max: 100000 }),
      (projectId, query, archived, memoryPage) => {
        const route = { view: "memory", projectId, query, archived, memoryPage };
        assert.deepEqual(parse(routePath(route)), route);
      },
    ),
  );
});
