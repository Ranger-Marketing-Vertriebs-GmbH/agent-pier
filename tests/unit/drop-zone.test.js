import test from "node:test";
import assert from "node:assert/strict";
import { dropDecision } from "../../web/components/useDropZone.js";

const accepts = (types) => types.includes("application/x-agentpier-pane");
const rect = { left: 0, top: 0, width: 100, height: 100 };

test("useDropZone ignores drags without the pane MIME type", () => {
  assert.equal(dropDecision({ types: ["Files"], accepts, rect, x: 5, y: 50 }), null);
});

test("useDropZone names the side under the pointer for pane drags", () => {
  const types = ["application/x-agentpier-pane"];
  assert.equal(dropDecision({ types, accepts, rect, x: 5, y: 50 }), "left");
  assert.equal(dropDecision({ types, accepts, rect, x: 50, y: 50 }), "center");
});

test("useDropZone reports no side when the side is not allowed", () => {
  const types = ["application/x-agentpier-pane"];
  const allowed = (side) => side === "center";
  assert.equal(dropDecision({ types, accepts, allowed, rect, x: 5, y: 50 }), null);
  assert.equal(dropDecision({ types, accepts, allowed, rect, x: 50, y: 50 }), "center");
});
