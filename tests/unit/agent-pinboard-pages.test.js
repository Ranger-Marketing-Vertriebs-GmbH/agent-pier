import test from "node:test";
import assert from "node:assert/strict";
import {
  PinboardPageGrants,
  pageFilePath,
  pinboardPagePath,
} from "../../server/features/assistants/agent-pinboard-pages.js";

test("page files resolve below the page's folder only", () => {
  const cases = [
    ["site/index.html", ["bilder", "01.png"], "site/bilder/01.png"],
    ["index.html", ["bilder", "01.png"], "bilder/01.png"],
    ["site/index.html", ["Sz%C3%A9ne%201.png"], "site/Széne 1.png"],
    ["site/index.html", [".."], null],
    ["site/index.html", ["%2E%2E", "secret.png"], null],
    ["site/index.html", ["bilder", "."], null],
    ["site/index.html", ["..%2Fsecret.png"], null],
    ["site/index.html", ["a%5Cb.png"], null],
    ["site/index.html", [".env"], null],
    ["site/index.html", ["bilder", ""], null],
    ["site/index.html", ["%E0%A4%A"], null],
    ["site/index.html", ["a%00.png"], null],
    ["site/index.html", [], null],
    ["site/index.html", Array(33).fill("a"), null],
  ];
  for (const [page, segments, expected] of cases)
    assert.equal(pageFilePath(page, segments), expected, segments.join("/"));
});

test("the security exemption covers grant paths only", () => {
  const grant = "a".repeat(43);
  assert.ok(pinboardPagePath.test(`/api/pinboard-pages/${grant}/index.html`));
  assert.ok(!pinboardPagePath.test(`/api/pinboard-pages/${grant}/`));
  assert.ok(!pinboardPagePath.test(`/api/pinboard-pages/${"a".repeat(42)}/x`));
  assert.ok(!pinboardPagePath.test(`/api/assistants/x/pinboard-pages/${grant}/x`));
});

test("grants lapse when idle, when old and when crowded out", () => {
  let now = 0;
  const grants = new PinboardPageGrants({
    now: () => now,
    idleMs: 100,
    lifetimeMs: 250,
    max: 2,
  });
  const token = grants.issue({ assistantId: "a", entryId: "e", session: "s" });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grants.resolve(token).entryId, "e");
  // Each use keeps it alive, up to its lifetime.
  for (now = 90; now <= 240; now += 90) assert.ok(grants.resolve(token));
  now = 260;
  assert.equal(grants.resolve(token), null);
  const idle = grants.issue({ assistantId: "a", entryId: "e", session: "s" });
  now = 361;
  assert.equal(grants.resolve(idle), null);
  const first = grants.issue({ assistantId: "a", entryId: "1", session: "s" });
  grants.issue({ assistantId: "a", entryId: "2", session: "s" });
  grants.issue({ assistantId: "a", entryId: "3", session: "s" });
  assert.equal(grants.resolve(first), null);
  assert.equal(grants.resolve("not a token"), null);
});
