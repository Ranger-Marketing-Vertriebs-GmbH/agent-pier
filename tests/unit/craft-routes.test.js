import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import { appDocumentPath } from "../../server/http/security.js";
import { menuArea } from "../../web/app/sidebar-menu-model.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const rebuild = "0b8c1f7e-3d2a-4c5b-9e6f-7a8b9c0d1e2f";

test("the Rebuilds page and a rebuild have addresses that read back the same", () => {
  assert.deepEqual(read("/craft"), { view: "craft", rebuildId: "" });
  assert.deepEqual(read(`/craft/${rebuild}`), { view: "craft", rebuildId: rebuild });
  assert.equal(routePath(read("/craft/")), "/craft");
  assert.equal(routePath(read(`/craft/${rebuild}`)), `/craft/${rebuild}`);
  assert.equal(routePath({ view: "craft" }), "/craft");
  for (const path of [
    "/craft/abc",
    `/craft/${rebuild}/x`,
    `/craft/${rebuild.toUpperCase()}`,
  ])
    assert.equal(read(path).view, "missing", path);
});

test("the Rebuilds page belongs to the Rebuilds menu entry", () => {
  assert.equal(menuArea(read("/craft")), "craft");
  assert.equal(menuArea(read(`/craft/${rebuild}`)), "craft");
});

test("the server serves the app for the Rebuilds page and a rebuild's question", () => {
  for (const path of [
    "/craft",
    "/craft/",
    `/craft/${rebuild}`,
    `/inbox/craft/${rebuild}%3Aq1`,
    `/inbox/craft/${rebuild}:q.1-a_b`,
  ])
    assert.equal(appDocumentPath.test(path), true, path);
  for (const path of [
    "/craft/abc",
    `/craft/${rebuild}/x`,
    "/inbox/craft/abc%3Aq1",
    `/inbox/craft/${rebuild}`,
    `/inbox/craft/${rebuild}%3A.q1`,
  ])
    assert.equal(appDocumentPath.test(path), false, path);
});
