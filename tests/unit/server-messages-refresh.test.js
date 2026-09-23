import test from "node:test";
import assert from "node:assert/strict";
import { germanServerMessages } from "../../server/lib/i18n/catalog-de.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  serverMessagesReady,
  serverMessagesVersion,
  serverText,
  subscribeServerMessages,
} from "../../web/lib/server-messages.js";

const reason = germanServerMessages.releases.smokeFailed;

test("loading the English catalog notifies views that rendered stored server text", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  let calls = 0;
  const unsubscribe = subscribeServerMessages(() => calls++);
  t.after(unsubscribe);
  setLanguage("de", { persist: false });
  await serverMessagesReady();
  assert.equal(calls, 0);
  const before = serverMessagesVersion();
  setLanguage("en", { persist: false });
  // Stored text without a key renders German until the catalog arrives.
  assert.equal(serverText(reason), reason);
  await serverMessagesReady();
  assert.equal(calls, 1);
  assert.equal(serverMessagesVersion(), before + 1);
  assert.equal(serverText(reason), englishServerMessages.releases.smokeFailed);
});
