import test from "node:test";
import assert from "node:assert/strict";
import { ticketHref, ticketLinkLabel } from "../../web/features/projects/ticket-list.js";

test("ticketLinkLabel names key and a short title", () => {
  assert.equal(
    ticketLinkLabel({ key: "AP-3", title: "x".repeat(100) }),
    `AP-3 · ${"x".repeat(80)}…`,
  );
  assert.equal(ticketLinkLabel({ key: "AP-3", title: "Short" }), "AP-3 · Short");
  assert.equal(ticketLinkLabel({ key: "AP-3", title: "" }), "AP-3");
});

test("ticketLinkLabel is empty without a ticket (null and undefined)", () => {
  assert.equal(ticketLinkLabel(null), "");
  assert.equal(ticketLinkLabel(undefined), "");
});

test("ticketHref keeps only http(s) URLs", () => {
  assert.equal(
    ticketHref({ url: "https://github.com/a/b/issues/7" }),
    "https://github.com/a/b/issues/7",
  );
  assert.equal(ticketHref({ url: "javascript:alert(1)" }), "");
  assert.equal(ticketHref({ url: "" }), "");
  assert.equal(ticketHref(null), "");
});
