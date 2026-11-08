// The memory page's pins (web/features/assistants/settings/memory-pins.js) count and
// split a Hermes memory file as the server does (hermes-config/memory.js), and a pin
// changes only its own entry.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  charsOf,
  entriesOf,
  pinMarker,
  pinnedCharsOf,
  togglePin,
} from "../../web/features/assistants/settings/memory-pins.js";
import {
  entryDelimiter,
  memoryChars,
  pinMarker as serverPinMarker,
  pinnedChars,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/memory.js";

// Entries with blanks, pins, emoji, a BOM and stray separators, joined as Hermes does.
// No lone "§": an entry whose text starts with a "§" line after a blank line is one
// that unpinning cannot keep apart from the entry before it (see togglePin).
const piece = fc.oneof(
  fc.string(),
  fc.constantFrom("", " ", "\n", "📌", "📌 ", "\n§\n", "﻿", "😀", "\t"),
);
const entry = fc.array(piece, { maxLength: 4 }).map((parts) => parts.join(""));
const memoryText = fc
  .array(entry, { maxLength: 6 })
  .map((entries) => entries.join(entryDelimiter));
const withEntries = memoryText.filter((text) => entriesOf(text).length > 0);

test("web and server count memory alike", () => {
  assert.equal(pinMarker, serverPinMarker);
  fc.assert(
    fc.property(memoryText, (text) => {
      assert.equal(charsOf(text), memoryChars(text));
      assert.equal(pinnedCharsOf(text), pinnedChars(text));
    }),
  );
  const text = "📌 Owner's vault is /srv/quartz\n§\n  Owner likes tea  \n§\n\n§\n";
  assert.deepEqual(entriesOf(text), [
    "📌 Owner's vault is /srv/quartz",
    "Owner likes tea",
  ]);
  assert.equal(charsOf(text), memoryChars(text));
  assert.equal(pinnedCharsOf(text), [..."📌 Owner's vault is /srv/quartz"].length);
});

// The entry as unpinning leaves it: without the markers it starts with.
const unpinned = (entry) => entry.replace(/^(?:📌 \s*)+/u, "");

test("toggling a pin twice restores the text", () => {
  fc.assert(
    fc.property(withEntries, fc.nat(), (text, n) => {
      const index = n % entriesOf(text).length;
      const entry = entriesOf(text)[index];
      const twice = togglePin(togglePin(text, index), index);
      // Byte for byte, unless a pinned entry had more than one marker or blanks after
      // it: the second pin then gives it the one marker it shows.
      if (!entry.startsWith(pinMarker) || entry === pinMarker + unpinned(entry))
        assert.equal(twice, text);
      else
        assert.deepEqual(
          entriesOf(twice),
          entriesOf(text).map((e, i) => (i === index ? pinMarker + unpinned(e) : e)),
        );
    }),
  );
  assert.equal(togglePin(togglePin("📌  Vault", 0), 0), "📌 Vault");
  assert.equal(togglePin("📌 📌 Vault", 0), "Vault");
});

test("a pin changes only its entry", () => {
  fc.assert(
    fc.property(withEntries, fc.nat(), (text, n) => {
      const before = entriesOf(text);
      const index = n % before.length;
      const toggled = togglePin(text, index);
      const after = entriesOf(toggled);
      assert.equal(after.length, before.length);
      for (const [i, entry] of before.entries()) {
        if (i !== index) assert.equal(after[i], entry);
        else if (entry.startsWith(pinMarker)) assert.equal(after[i], unpinned(entry));
        else assert.equal(after[i], `${pinMarker}${entry}`);
      }
      // The other parts keep their bytes, blanks and empty parts included.
      const raw = text.split(entryDelimiter);
      const next = toggled.split(entryDelimiter);
      assert.equal(next.length, raw.length);
      assert.equal(next.filter((part, i) => part !== raw[i]).length, 1);
    }),
  );
  assert.equal(
    togglePin("Owner likes tea\n§\n  📌 Vault  \n§\nrest", 1),
    "Owner likes tea\n§\n  Vault  \n§\nrest",
  );
  assert.equal(togglePin("\n§\nOwner likes tea", 0), "\n§\n📌 Owner likes tea");
  assert.equal(togglePin("Owner likes tea", 3), "Owner likes tea");
});
