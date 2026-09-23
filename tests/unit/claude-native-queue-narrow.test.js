import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  nativeInputQueue,
  inputHash,
} from "../../server/features/chat/native-input-queue.js";
import { claudePlaceholder } from "../../server/features/sessions/claude-composer.js";

// Real Claude Code 2.1.280 frames while a turn is busy and 1–3 messages wait in
// the native queue: 24–40 columns (truncated placeholder, wrapped send-now hint
// and wrapped queued rows) and colorless panes.
const read = (name) =>
  JSON.parse(fs.readFileSync(new URL(`../fixtures/tui-input/${name}`, import.meta.url)));
const narrow = read("claude-2.1.280-queue-narrow.json");
const screens = read("claude-2.1.280-screens.json");
const queue = ({ raw, pane }) => nativeInputQueue("claude", raw, pane);
const hashes = (...texts) => texts.map(inputHash);
const panes = ["w24", "w30", "w34", "w40", "noColor80", "forceColor0x24"];

test("claude queue is read at 24–40 columns and without color", () => {
  for (const name of panes) {
    const frames = narrow[name];
    assert.deepEqual(queue(frames.busy), [], name);
    assert.deepEqual(queue(frames.queueOne), hashes("q one"), name);
    assert.deepEqual(queue(frames.queueTwo), hashes("q one", "q two"), name);
    assert.deepEqual(queue(frames.queueThree), hashes("q one", "q two", "q three"), name);
    // The wrapped long entry stays unknown; the complete rows are still read.
    assert.deepEqual(queue(frames.queueLong), hashes("q one", "q two", "q three"), name);
  }
  for (const name of ["queueNarrow30", "queueNarrow34", "queueNoColor"])
    assert.deepEqual(queue(screens[name]), hashes("AP_PROBE_Q queued msg"), name);
});

test("a single queued row may fill a narrow pane", () => {
  const { raw, pane } = narrow.w24.queueOne;
  const full = "AP_PROBE_SECOND abc de"; // 22 cells: "❯ " + text fills 24 columns
  assert.deepEqual(queue({ raw: raw.replace("q one", full), pane }), hashes(full));
  const clipped = "AP_PROBE_SECOND abc d…";
  assert.deepEqual(queue({ raw: raw.replace("q one", clipped), pane }), []);
});

test("narrow queue chrome must be complete and belong to the queued placeholder", () => {
  const { raw, pane } = narrow.w24.queueTwo;
  assert.match(raw, /ctrl\+x ctrl\+s to send\n.*now/);
  for (const changed of [
    raw.replace("ctrl+x ctrl+s to send", "ctrl+x ctrl+s to stop"),
    raw.replace(/(ctrl\+x ctrl\+s to send\n.*)now/, "$1later"),
    raw.replace("\x1b[0;2mress up to edit queu…", "\x1b[0;2mlease fix lint errors"),
    raw.replace("ress up to edit queu…", "ress up to edit quiet…"),
  ]) {
    assert.notEqual(changed, raw);
    assert.deepEqual(queue({ raw: changed, pane }), []);
  }
  assert.deepEqual(queue({ raw, pane: { ...pane, cursorX: 5 } }), []);
  const colorless = narrow.noColor80.queueTwo;
  assert.deepEqual(
    queue({
      raw: colorless.raw.replace(
        /(❯.\x1b\[7mP\x1b\[0m)ress up to edit queued messages/,
        "$1lease run the tests",
      ),
      pane: colorless.pane,
    }),
    [],
  );
});

test("only the queued placeholder satisfies the queued placeholder check", () => {
  const pane = { cursorX: 2 };
  const dim = (text) =>
    `\x1b[38;2;153;153;153m❯ \x1b[7m\x1b[39m${text[0]}\x1b[0;2m${text.slice(1)}`;
  assert.equal(claudePlaceholder(dim("Try 'fix lint errors'"), pane), true);
  assert.equal(
    claudePlaceholder(dim("Try 'fix lint errors'"), pane, { queued: true }),
    false,
  );
  for (const text of ["Press up to edit queued messages", "Press up to edit queu…"])
    assert.equal(claudePlaceholder(dim(text), pane, { queued: true }), true, text);
});
