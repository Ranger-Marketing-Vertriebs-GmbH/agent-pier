// ⌘K / Ctrl+K guard (handoff §5.9, AC-SR-1): the shortcut per platform, and never
// inside a terminal, the code editor or a text field other than the search's own.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isMacPlatform,
  isSearchShortcut,
  opensSearch,
  ownsShortcut,
} from "../../web/app/search-shortcut.js";
import { requestPageAction, takePageAction } from "../../web/app/page-action.js";

// A minimal element: `inside` lists the selectors `closest` finds an ancestor for.
const element = ({ tag = "DIV", type, editable = false, inside = [] } = {}) => ({
  tagName: tag,
  type,
  isContentEditable: editable,
  closest: (selectors) =>
    selectors
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => inside.includes(selector))
      ? {}
      : null,
});
const key = (fields) => ({
  key: "k",
  code: "KeyK",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: element(),
  ...fields,
});

test("macOS uses ⌘K, other platforms Ctrl+K", () => {
  assert.equal(isSearchShortcut(key({ metaKey: true }), true), true);
  assert.equal(isSearchShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isSearchShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isSearchShortcut(key({ metaKey: true }), false), false);
  assert.equal(isSearchShortcut(key({ metaKey: true, key: "K" }), true), true);
  assert.equal(isSearchShortcut(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isSearchShortcut(key({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(
    isSearchShortcut(key({ ctrlKey: true, key: "j", code: "KeyJ" }), false),
    false,
  );
  // A layout without a Latin letter there still has the K key.
  assert.equal(isSearchShortcut(key({ ctrlKey: true, key: "л" }), false), true);
  // A Latin layout whose K key types another letter follows the letter.
  assert.equal(isSearchShortcut(key({ ctrlKey: true, key: "t" }), false), false);
});

test("the platform comes from the browser", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ platform: "iPhone" }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(isMacPlatform({ platform: "Linux x86_64" }), false);
  assert.equal(isMacPlatform({ userAgentData: { platform: "Windows" } }), false);
  assert.equal(isMacPlatform({}), false);
});

test("terminals, the code editor and text fields keep the shortcut", () => {
  assert.equal(ownsShortcut(element({ tag: "TEXTAREA", inside: [".xterm"] })), true);
  assert.equal(ownsShortcut(element({ editable: true, inside: [".cm-editor"] })), true);
  assert.equal(ownsShortcut(element({ inside: [".cm-editor"] })), true);
  assert.equal(ownsShortcut(element({ tag: "INPUT", type: "text" })), true);
  assert.equal(ownsShortcut(element({ tag: "INPUT", type: "search" })), true);
  assert.equal(ownsShortcut(element({ tag: "INPUT" })), true);
  assert.equal(ownsShortcut(element({ tag: "TEXTAREA" })), true);
  assert.equal(ownsShortcut(element({ editable: true })), true);
});

test("buttons, checkboxes, the page and the search field do not", () => {
  assert.equal(ownsShortcut(element({ tag: "BUTTON" })), false);
  assert.equal(ownsShortcut(element({ tag: "INPUT", type: "checkbox" })), false);
  assert.equal(ownsShortcut(element({ tag: "INPUT", type: "radio" })), false);
  assert.equal(ownsShortcut(element({ tag: "BODY" })), false);
  assert.equal(
    ownsShortcut(
      element({ tag: "INPUT", type: "text", inside: ["[data-search-input]"] }),
    ),
    false,
  );
  assert.equal(ownsShortcut(null), false);
});

test("opening needs the shortcut outside a typing area and not handled yet", () => {
  assert.equal(opensSearch(key({ metaKey: true }), true), true);
  assert.equal(
    opensSearch(key({ metaKey: true, target: element({ inside: [".xterm"] }) }), true),
    false,
  );
  assert.equal(
    opensSearch(key({ ctrlKey: true, target: element({ tag: "INPUT" }) }), false),
    false,
  );
  assert.equal(opensSearch(key({ metaKey: true, defaultPrevented: true }), true), false);
});

test("a page action is taken once and expires", () => {
  requestPageAction("ssh-add", 1000);
  assert.equal(takePageAction("secret-add", 1000), false);
  assert.equal(takePageAction("ssh-add", 2000), true);
  assert.equal(takePageAction("ssh-add", 2000), false);
  requestPageAction("ssh-add", 1000);
  assert.equal(takePageAction("ssh-add", 60_000), false, "an old request expired");
  assert.equal(takePageAction("ssh-add", 60_001), false);
});
