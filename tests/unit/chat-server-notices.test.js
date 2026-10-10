import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { germanServerMessages } from "../../server/lib/i18n/catalog-de.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { serverMessagesReady, serverText } from "../../web/lib/server-messages.js";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
// Chat snapshots carry German notices without a messageKey; the view translates them.
const noticeKeys = [
  ...read("server/features/chat/chat-store.js").matchAll(/serverMessages\.chat\.(\w+)/g),
].map(([, key]) => key);

test("every German chat notice from the server renders in English", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  assert.ok(noticeKeys.includes("emptyHistoryNotice"));
  setLanguage("en", { persist: false });
  await serverMessagesReady();
  for (const key of new Set(noticeKeys)) {
    const german = germanServerMessages.chat[key];
    if (typeof german !== "string") continue;
    assert.equal(serverText(german), englishServerMessages.chat[key], key);
    assert.notEqual(serverText(german), german, key);
  }
});

test("chat views never render server notices without translation", () => {
  for (const file of fs.readdirSync(new URL("../../web/features/chat/", import.meta.url)))
    if (file.endsWith(".jsx"))
      assert.doesNotMatch(
        read(`web/features/chat/${file}`),
        /\{\s*data\??\.notice\s*\}/,
        `${file} renders data.notice without serverText()`,
      );
});
