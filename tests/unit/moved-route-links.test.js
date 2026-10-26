import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// AC-RT-4: no hard-coded link in web/ points to an address that moved with the
// navigation redesign. Pages link through route builders (routePath, connections and
// coding routes); old addresses appear only where the router reads them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const movedAddress = new RegExp(
  [
    String.raw`["'\x60]/settings/(?:assistants|assistants-advanced|ssh|secrets|github|mcp)\b`,
    String.raw`["'\x60]/settings\?tab=(?:access|workspace)\b`,
    String.raw`["'\x60]/accounts(?=[?"'\x60])`,
    String.raw`["'\x60]/(?:extensions|plugins)(?=[/?"'\x60])`,
    String.raw`/settings\?(?:[^"'\x60]*&)?tab=(?:work|routines|telegram|profile)\b`,
  ].join("|"),
  "g",
);
// Files that read old addresses (the redirect table), and API calls whose path only
// looks like a page address (`api("/accounts")` posts to /api/accounts).
const allowed = new Map([
  ["web/app/routes.js", null],
  ["web/app/route-redirects.js", null],
  ["web/features/coding/accounts/native-account-save.js", new Set(['"/accounts'])],
]);

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(?:js|jsx)$/.test(entry.name) ? [full] : [];
  });
}

test("no hard-coded link in web/ points to a moved address", () => {
  const found = [];
  for (const file of sources(path.join(root, "web"))) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const exception = allowed.get(relative);
    if (allowed.has(relative) && exception === null) continue;
    for (const match of readFileSync(file, "utf8").matchAll(movedAddress))
      if (!exception?.has(match[0])) found.push(`${relative}: ${match[0]}`);
  }
  assert.deepEqual(found, []);
});

test("the moved-address check recognises old links", () => {
  for (const sample of [
    `<a href="/settings/ssh">`,
    `href: "/settings/mcp?authorization=x"`,
    `const target = "/accounts?section=services";`,
    "navigate(`/extensions/${id}`)",
    `"/plugins"`,
    `"/settings?tab=access"`,
  ])
    assert.match(sample, new RegExp(movedAddress.source), sample);
  for (const sample of [
    `import x from "../extensions/routes.js";`,
    `api("/accounts/usage")`,
    `"/settings/users"`,
    `"/connections?section=ssh"`,
  ])
    assert.doesNotMatch(sample, new RegExp(movedAddress.source), sample);
});
