import test from "node:test";
import assert from "node:assert/strict";
import {
  historyCalls,
  historyStep,
  navigationAllowed,
  typedAddress,
  validateNavigation,
  validateTab,
} from "../../server/features/assistants/browser-navigation.js";

// The browser toolbar's commands (browser-navigation.js): what the owner types or
// presses becomes a checked command, and back, forward, reload and stop become the
// CDP calls the takeover sends to the shown tab.

test("a typed address becomes a web address, anything else is refused", () => {
  assert.equal(typedAddress("example.com"), "https://example.com/");
  assert.equal(typedAddress("  shop.example/cart?x=1 "), "https://shop.example/cart?x=1");
  assert.equal(
    typedAddress("http://intranet.example:8080/a"),
    "http://intranet.example:8080/a",
  );
  assert.equal(typedAddress("HTTPS://Example.com"), "https://example.com/");
  // A host with a port is not read as a scheme.
  assert.equal(typedAddress("localhost:3000"), "https://localhost:3000/");
  assert.equal(typedAddress("about:blank"), "about:blank");
  for (const refused of [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "chrome://settings",
    "view-source:https://a.example/",
    "about:config",
    // Credentials never travel in an address (OpenClaw refuses them too).
    "https://user:secret@example.com/",
    "two words",
    "https://exa mple.com/",
    "a\u0000b.example",
    `https://example.com/${"x".repeat(2100)}`,
    42,
    null,
  ])
    assert.equal(typedAddress(refused), null, String(refused));
});

test("navigation commands are checked and mapped", () => {
  assert.deepEqual(
    validateNavigation({ type: "navigate", action: "go", url: "a.example" }),
    {
      action: "go",
      url: "https://a.example/",
    },
  );
  for (const action of ["back", "forward", "reload", "stop"])
    assert.deepEqual(validateNavigation({ type: "navigate", action }), { action });
  for (const invalid of [
    null,
    "go",
    { type: "navigate" },
    { type: "navigate", action: "evaluate" },
    { type: "navigate", action: "go" },
    { type: "navigate", action: "go", url: "javascript:void(0)" },
    { type: "pointer", action: "back" },
  ])
    assert.equal(validateNavigation(invalid), null);
  assert.deepEqual(historyCalls("reload"), [["Page.reload", {}]]);
  assert.deepEqual(historyCalls("stop"), [["Page.stopLoading", {}]]);
  assert.deepEqual(historyCalls("back"), [["Page.getNavigationHistory", {}]]);
  assert.deepEqual(historyCalls("forward"), [["Page.getNavigationHistory", {}]]);
});

test("back and forward step through the tab's own history", () => {
  const history = {
    currentIndex: 1,
    entries: [
      { id: 10, url: "https://a.example/" },
      { id: 11, url: "https://b.example/" },
      { id: 12, url: "https://c.example/" },
    ],
  };
  assert.deepEqual(historyStep(history, "back"), { id: 10, url: "https://a.example/" });
  assert.deepEqual(historyStep(history, "forward"), {
    id: 12,
    url: "https://c.example/",
  });
  assert.equal(historyStep({ ...history, currentIndex: 0 }, "back"), null);
  assert.equal(historyStep({ ...history, currentIndex: 2 }, "forward"), null);
  assert.equal(historyStep({}, "back"), null);
  assert.equal(historyStep(null, "back"), null);
  assert.equal(
    historyStep({ currentIndex: 1, entries: [{}, { id: "x" }] }, "back"),
    null,
  );
});

test("tab commands name a tab and switch or close it", () => {
  assert.deepEqual(validateTab({ type: "tab", action: "switch", targetId: "T2" }), {
    action: "switch",
    targetId: "T2",
  });
  assert.deepEqual(validateTab({ type: "tab", action: "close", targetId: "T2" }), {
    action: "close",
    targetId: "T2",
  });
  for (const invalid of [
    { type: "tab", action: "open", targetId: "T2" },
    { type: "tab", action: "close" },
    { type: "tab", action: "close", targetId: "" },
    { type: "tab", action: "close", targetId: "x".repeat(201) },
    { type: "tab", action: "close", targetId: 7 },
  ])
    assert.equal(validateTab(invalid), null);
});

test("the private-network rule of the agent browser applies to owner navigation", async () => {
  const lookup = async (host) =>
    ({
      "public.example": [{ address: "93.184.216.34", family: 4 }],
      "rebind.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      "v6.example": [{ address: "fd00::1", family: 6 }],
    })[host] ?? Promise.reject(Error("ENOTFOUND"));
  const strict = { allowPrivateNetwork: false, lookup };
  assert.equal(await navigationAllowed("https://public.example/", strict), true);
  assert.equal(await navigationAllowed("about:blank", strict), true);
  for (const blocked of [
    "http://127.0.0.1:4380/",
    "http://localhost/",
    "http://app.localhost/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://rebind.example/",
    "https://v6.example/",
    // A name that does not resolve is refused, not guessed.
    "https://nowhere.example/",
    "javascript:alert(1)",
    "file:///etc/hosts",
  ])
    assert.equal(await navigationAllowed(blocked, strict), false, blocked);
  // The owner's opt-in (Allow private networks) allows them, as for the agent.
  const open = { allowPrivateNetwork: true, lookup };
  assert.equal(await navigationAllowed("http://127.0.0.1:4380/", open), true);
  assert.equal(await navigationAllowed("http://192.168.1.1/", open), true);
  assert.equal(await navigationAllowed("javascript:alert(1)", open), false);
});
