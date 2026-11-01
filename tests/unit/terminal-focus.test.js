import test from "node:test";
import assert from "node:assert/strict";
import { takesFocus } from "../../web/features/terminal/terminal-focus.js";

// A minimal element tree: `contains` walks up the parents, `closest` matches a class.
function element(className = "", parent = null) {
  const node = {
    className,
    parent,
    contains: (other) => {
      for (let current = other; current; current = current.parent)
        if (current === node) return true;
      return false;
    },
    closest: (selector) => {
      const name = selector.replace(/^\./, "");
      for (let current = node; current; current = current.parent)
        if (current.className.split(" ").includes(name)) return current;
      return null;
    },
  };
  return node;
}

const body = element("body");
const workspace = element("session-workspace in-pane", body);
const header = element("session-pane-header", workspace);
const field = element("pane-field", header);
const mount = element("terminal-mount", workspace);
const row = element("xterm-row", mount);
const otherPane = element("session-workspace in-pane", body);
const sidebarLink = element("sidebar-link", body);

const focusCase = (overrides) => ({
  mode: "terminal",
  autoFocus: true,
  gained: false,
  active: body,
  body,
  mount,
  ...overrides,
});

test("the single view focuses its terminal on mount and on a mode change", () => {
  assert.equal(takesFocus(focusCase({ active: field })), true);
  assert.equal(takesFocus(focusCase({ active: body })), true);
});

test("an unfocused pane or another mode leaves the focus alone", () => {
  assert.equal(takesFocus(focusCase({ autoFocus: false })), false);
  assert.equal(takesFocus(focusCase({ mode: "reader" })), false);
});

test("a pane focused by a click into its own chrome keeps that field focused", () => {
  assert.equal(takesFocus(focusCase({ gained: true, active: field })), false);
});

test("a pane focused from elsewhere hands the focus to its terminal", () => {
  assert.equal(takesFocus(focusCase({ gained: true, active: body })), true);
  assert.equal(takesFocus(focusCase({ gained: true, active: null })), true);
  assert.equal(takesFocus(focusCase({ gained: true, active: sidebarLink })), true);
  assert.equal(takesFocus(focusCase({ gained: true, active: otherPane })), true);
  assert.equal(takesFocus(focusCase({ gained: true, active: row })), true);
});

test("without a mount yet a gained focus does not steal from a field", () => {
  assert.equal(
    takesFocus(focusCase({ gained: true, active: field, mount: null })),
    false,
  );
});

test("a terminal in a pane never takes the focus from a field outside it", () => {
  const viewName = { ...element("view-header", body), tagName: "INPUT" };
  const composer = { ...element("composer", otherPane), tagName: "TEXTAREA" };
  assert.equal(takesFocus(focusCase({ active: viewName })), false);
  assert.equal(takesFocus(focusCase({ active: composer })), false);
  assert.equal(takesFocus(focusCase({ gained: true, active: composer })), false);
  const xtermInput = { ...element("xterm-helper-textarea", mount), tagName: "TEXTAREA" };
  assert.equal(takesFocus(focusCase({ active: xtermInput })), true);
  // A single view keeps today's behaviour.
  const single = element("terminal-mount", element("session-workspace", body));
  assert.equal(takesFocus(focusCase({ active: viewName, mount: single })), true);
});
