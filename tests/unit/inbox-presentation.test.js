import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { itemContext, kindLabel } from "../../web/features/inbox/inbox-presentation.js";

const mailItem = (mail) => ({
  type: "action",
  kind: "mail_send",
  title: "Private · Offer",
  source: { name: "Helper" },
  ...(mail && { mail }),
});

test("an email's kind names a forward, its attachments and the original's HTML", () => {
  setLanguage("en");
  try {
    assert.equal(kindLabel(mailItem()), "Email to send");
    assert.equal(
      kindLabel(mailItem({ attachments: 0, forward: false, html: null })),
      "Email to send",
    );
    assert.equal(
      kindLabel(mailItem({ attachments: 2, forward: false, html: null })),
      "Email to send · 2 attachments",
    );
    assert.equal(
      kindLabel(mailItem({ attachments: 1, forward: true, html: "kept" })),
      "Email to forward · 1 attachment · with the original's HTML version",
    );
    assert.equal(
      itemContext(mailItem({ attachments: 0, forward: true, html: "omitted" })),
      "Email to forward · without the original's HTML version · Helper",
    );
    assert.equal(
      kindLabel(mailItem({ attachments: 0, forward: false, html: "draft" })),
      "Email to send · with an HTML version",
    );
    setLanguage("de");
    assert.equal(
      kindLabel(mailItem({ attachments: 2, forward: true, html: null })),
      "E-Mail zum Weiterleiten · 2 Anhänge",
    );
  } finally {
    setLanguage("de");
  }
});
