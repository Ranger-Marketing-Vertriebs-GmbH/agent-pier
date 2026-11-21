// System status sizes (W8 B4): no "0 byte" or "0 BYTE"; an empty group offers no list.
import test from "node:test";
import assert from "node:assert/strict";
import {
  nothingToClean,
  statusBytes,
} from "../../web/features/dashboard/system-status-format.js";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";

test("sizes below a kilobyte read as bytes with the short unit in both languages", (t) => {
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.equal(statusBytes(0), "0 B");
  assert.equal(statusBytes(512), "512 B");
  assert.equal(statusBytes(), "0 B");
  assert.equal(statusBytes(2048), "2 kB");
  setLanguage("de");
  assert.equal(statusBytes(0), "0 B");
  assert.equal(statusBytes(1023), "1.023 B");
  assert.doesNotMatch(statusBytes(5 * 1024 ** 3), /byte/i);
});

test("a measured group without entries has nothing to clean", () => {
  assert.equal(nothingToClean({ count: 0, bytes: 0 }), true);
  assert.equal(nothingToClean({ count: 2, bytes: 10 }), false);
  // Not measured yet: the list may still be opened.
  assert.equal(nothingToClean(null), false);
});
