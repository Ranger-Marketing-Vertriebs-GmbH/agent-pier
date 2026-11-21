// Every page address of the web app (web/app/routes.js) is served as the app document
// (server/http/security.js appDocumentPath): a reload or a link from Telegram or mail
// opens the page instead of 404, and a cross-site navigation is allowed (AGENTPIER-415,
// AGENTPIER-422). A new route in routes.js without its server pattern fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appDocumentPath } from "../../server/http/security.js";
import { readRoute, routePath } from "../../web/app/routes.js";
import { sections as settingsSections } from "../../web/features/operations/routes.js";
import { inboxTypes } from "../../web/features/inbox/routes.js";

const uuid = "0123abcd-0123-4abc-8def-0123456789ab";
// One address per path pattern routes.js and its feature readers accept.
const addresses = [
  "/",
  "/agents",
  // The bare agent address redirects in the app; the server must not 404 it first.
  "/agents/a-1",
  ...["settings", "browser", "pinboard", "chats/c-1", "teams/t-1"].map(
    (rest) => `/agents/a-1/${rest}`,
  ),
  "/connections",
  "/coding/clis",
  "/coding/clis/extensions",
  "/coding/clis/extensions/local-codex",
  "/accounts",
  "/inbox",
  ...inboxTypes.filter((type) => type !== "craft").map((type) => `/inbox/${type}/item-1`),
  `/inbox/craft/${uuid}%3Aq-1`,
  "/repositories",
  "/files",
  "/projects",
  "/projects/p-1",
  "/settings",
  ...[...settingsSections].map((section) => `/settings/${section}`),
  "/pipelines",
  ...["runs", "definitions", "profiles", "verification", "queue"].flatMap((tab) => [
    `/pipelines/${tab}`,
    `/pipelines/${tab}/item-1`,
  ]),
  "/craft",
  `/craft/${uuid}`,
  "/artifacts",
  "/artifacts/p-1",
  "/memory",
  "/memory/p-1",
  "/agentbus",
  "/agentbus/messages",
  "/agentbus/messages/p-1",
  "/extensions",
  "/extensions/p-1",
  "/plugins/p-1",
  "/views/v_0123456789abcdef",
  "/sessions/s-1",
  ...["chat", "reader", "terminal", "files", "changes"].map(
    (mode) => `/sessions/s-1/${mode}`,
  ),
];

test("every page address of the web app is served as the app document", () => {
  for (const address of addresses) {
    const route = readRoute(new URL(address, "http://localhost"));
    assert.notEqual(route.view, "missing", address);
    assert.equal(appDocumentPath.test(address), true, address);
    // The canonical address the app writes after a redirect is served too.
    const canonical = routePath(route).split("?")[0];
    assert.equal(appDocumentPath.test(canonical), true, `${address} → ${canonical}`);
  }
});

test("the address list covers every path pattern of routes.js", () => {
  // Each `pathname === "/x"` and `/^\/x…/` in routes.js names a first segment; a new
  // one needs its addresses above.
  const source = readFileSync(
    new URL("../../web/app/routes.js", import.meta.url),
    "utf8",
  );
  const firsts = new Set(
    [
      ...source.matchAll(/pathname === "\/([a-z-]+)"/g),
      ...source.matchAll(/\/\^\\\/\(?(?:\?:)?([a-z|-]+)/g),
    ].flatMap((match) => match[1].split("|")),
  );
  const covered = new Set(addresses.map((address) => address.split("/")[1]));
  for (const first of firsts) assert.ok(covered.has(first), first);
});

test("API, asset and unknown paths are not app documents", () => {
  for (const address of [
    "/api/state",
    "/views",
    "/views/a/b",
    "/pipelines/queue/a/b",
    "/agents/a-1/pinboard/x",
    "/assets/index.js",
  ])
    assert.equal(appDocumentPath.test(address), false, address);
});
