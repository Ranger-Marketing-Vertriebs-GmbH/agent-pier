import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// German names a stored provider connection "Provider-Zugang", like the sibling
// "SSH-Zugänge" and "GitHub-Zugänge"; a second term for the same thing confuses users.
test("German catalogs use one term for provider connections", async () => {
  for (const dir of ["../../web/lib/i18n/de/", "../../server/lib/i18n/de/"]) {
    const base = new URL(dir, import.meta.url);
    for (const name of await readdir(base)) {
      if (!name.endsWith(".js")) continue;
      const text = await readFile(new URL(name, base), "utf8");
      assert.doesNotMatch(text, /Provider-Verbindung/, `${dir}${name}`);
      // Agent copy once called the same thing "Modellverbindung" or "diese Verbindung";
      // remote access copy describes a network connection and keeps the word.
      if (name === "remote.js") continue;
      assert.doesNotMatch(
        text,
        /Modell-?verbindung|diese Verbindung\b|Verbindung fehlt/i,
        `${dir}${name}`,
      );
    }
  }
});

// Pipeline copy calls automated checks "Prüfung"/"Prüfschritt" and a run "Lauf".
test("German pipeline catalogs use one term for verification and the run branch", async () => {
  for (const dir of ["../../web/lib/i18n/de/", "../../server/lib/i18n/de/"]) {
    const base = new URL(dir, import.meta.url);
    for (const name of await readdir(base)) {
      if (!name.startsWith("pipeline")) continue;
      const text = await readFile(new URL(name, base), "utf8");
      assert.doesNotMatch(text, /Verifikation|Run-Branch/, `${dir}${name}`);
    }
  }
});
