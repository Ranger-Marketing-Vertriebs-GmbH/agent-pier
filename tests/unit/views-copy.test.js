import test from "node:test";
import assert from "node:assert/strict";
import { viewsCopy as de } from "../../web/lib/i18n/de/views.js";
import { viewsCopy as en } from "../../web/lib/i18n/en/views.js";

test("a view row names one pane in the singular", () => {
  assert.equal(en.rowLabel("Pairing", 1), "Pairing, 1 pane");
  assert.equal(en.rowLabel("Shop", 3), "Shop, 3 panes");
  assert.equal(en.rowLabel("Empty", 0), "Empty, 0 panes");
  assert.equal(de.rowLabel("Pairing", 1), "Pairing, 1 Bereich");
  assert.equal(de.rowLabel("Shop", 3), "Shop, 3 Bereiche");
  assert.equal(de.rowLabel("Leer", 0), "Leer, 0 Bereiche");
});
