import test from "node:test";
import assert from "node:assert/strict";
import {
  crossLinkRoute,
  readRoute,
  returnRoute,
  routePath,
} from "../../web/app/routes.js";
import { appPathParts, withoutReturnParam } from "../../web/app/return-to.js";

const read = (path) => readRoute(new URL(path, "http://localhost"));
const withReturn = (path, returnTo) =>
  `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ returnTo })}`;
const telegram = {
  view: "agents",
  assistantId: "home",
  agentSettings: true,
  agentTab: "telegram",
};

test("a cross-link from agent settings carries the exact origin tab", () => {
  const target = crossLinkRoute(
    { view: "accounts", section: "services", item: "speech" },
    telegram,
  );
  assert.equal(target.returnTo, "/agents/home/settings?tab=telegram");
  const path = routePath(target);
  assert.equal(
    path,
    "/accounts?section=services&item=speech&returnTo=%2Fagents%2Fhome%2Fsettings%3Ftab%3Dtelegram",
  );
  const reloaded = read(path);
  assert.deepEqual(reloaded, { view: "accounts", ...target });
  assert.equal(routePath(reloaded), path);
  assert.deepEqual(returnRoute(reloaded), {
    view: "agents",
    assistantId: "home",
    agentSettings: true,
    agentTab: "telegram",
  });
});

test("settings subpages keep returnTo through a reload", () => {
  const target = crossLinkRoute(
    { view: "settings", settingsSection: "assistants" },
    { view: "agents", assistantId: "home", agentSettings: true },
  );
  const reloaded = read(routePath(target));
  assert.equal(reloaded.settingsSection, "assistants");
  assert.equal(reloaded.returnTo, "/agents/home/settings");
  assert.equal(routePath(returnRoute(reloaded)), "/agents/home/settings");
});

test("links inside one area, to other views or without an origin stay plain", () => {
  const accounts = { view: "accounts", section: "models" };
  assert.equal(crossLinkRoute(accounts, null), accounts);
  assert.equal(crossLinkRoute(accounts, { view: "accounts" }), accounts);
  const chat = { view: "agents", assistantId: "home", conversationId: "c1" };
  assert.equal(crossLinkRoute(chat, { view: "settings" }), chat);
  // A session is no origin a cross-link returns to.
  assert.equal(
    crossLinkRoute(accounts, { view: "workspace", sessionId: "s1", mode: "terminal" }),
    accounts,
  );
  assert.equal(read("/accounts?section=models").returnTo, undefined);
  assert.equal(routePath({ view: "agents", returnTo: "/settings" }), "/agents");
});

test("malicious or foreign returnTo values are dropped", () => {
  for (const value of [
    "https://evil.example/agents/home/settings",
    "//evil.example/agents/home/settings",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)//",
    "data:text/html,<script>alert(1)</script>",
    "agents/home/settings",
    "/agents/home/settings\n",
    "/agents/home%0a/settings",
    "/agents/../settings",
    "/api/state",
    "/sessions/s1/terminal",
    "/artifacts",
    "/nowhere",
    "",
    `/settings?x=${"a".repeat(3000)}`,
  ]) {
    const route = read(withReturn("/accounts", value));
    assert.equal(route.returnTo, undefined, value);
    assert.equal(returnRoute({ returnTo: value }), null, value);
    assert.equal(routePath(route), "/accounts", value);
  }
});

test("returnTo is rebuilt from the parsed origin, never echoed", () => {
  const route = read(
    withReturn("/settings/assistants", "/agents/home/settings?tab=work&evil=<x>#frag"),
  );
  assert.equal(route.returnTo, "/agents/home/settings?tab=work");
  // A nested returnTo in the origin is cut off instead of chaining.
  const nested = read(
    withReturn("/accounts", withReturn("/settings/assistants", "/agents/home/settings")),
  );
  assert.equal(nested.returnTo, "/settings/assistants");
  assert.equal(returnRoute(nested).returnTo, undefined);
  assert.equal(
    crossLinkRoute(
      { view: "settings", settingsSection: "assistants" },
      { view: "accounts", returnTo: "/agents/home/settings" },
    ).returnTo,
    "/accounts",
  );
});

test("appPathParts accepts only same-origin app paths", () => {
  assert.deepEqual(appPathParts("/accounts?section=models#top"), {
    pathname: "/accounts",
    search: "?section=models",
    hash: "#top",
  });
  for (const value of [null, undefined, 42, "", "accounts", "//x", "/a\\b", "/a\tb"])
    assert.equal(appPathParts(value), null, String(value));
  assert.equal(withoutReturnParam("?tab=work&returnTo=%2Fx"), "?tab=work");
  assert.equal(withoutReturnParam("?returnTo=%2Fx"), "");
});
