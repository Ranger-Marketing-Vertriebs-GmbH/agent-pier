import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentTexts,
  mailHtmlState as serverHtmlState,
  mailTelegramApprovable,
} from "../../server/features/assistants/mail/agent-mail-send-input.js";
import {
  mailHasHidden,
  mailHtmlState as webHtmlState,
  mailLineTexts,
} from "../../web/features/assistants/mail-card-text.js";

// The web card and Telegram check the same single-line fields of a mail card and
// read its HTML state alike.

const payload = {
  body: "Hi\nthere",
  subject: "Offer",
  from: { name: "Agent", address: "agent@example.com" },
  to: ["bob@example.org"],
  attachments: [
    {
      name: "n1",
      type: "t1",
      source: {
        kind: "draft",
        from: "project",
        path: "p1",
        projectName: "j1",
        agentName: "g1",
      },
    },
    { name: "n2", type: "t2", source: { kind: "original" } },
  ],
  forward: { from: { name: "fn", address: "fa" }, subject: "fs", date: "fd" },
};

test("server and web list the same single-line fields", () => {
  assert.deepEqual(mailLineTexts(payload), attachmentTexts(payload));
  assert.deepEqual(attachmentTexts(payload), [
    "n1",
    "t1",
    "p1",
    "j1",
    "g1",
    "n2",
    "t2",
    undefined,
    undefined,
    undefined,
    "fn",
    "fa",
    "fs",
    "fd",
  ]);
});

test("a control character in any single-line field hides on both sides", () => {
  assert.equal(mailHasHidden(payload), false);
  assert.equal(mailTelegramApprovable(payload), true);
  const texts = attachmentTexts(payload);
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] === undefined) continue;
    for (const c of ["\n", "\r", "\t", "\u200b", "\u2028", "\u2029", "\u0085"]) {
      const changed = structuredClone(payload);
      const set = (value) => {
        const a = changed.attachments;
        const slots = [
          (v) => (a[0].name = v),
          (v) => (a[0].type = v),
          (v) => (a[0].source.path = v),
          (v) => (a[0].source.projectName = v),
          (v) => (a[0].source.agentName = v),
          (v) => (a[1].name = v),
          (v) => (a[1].type = v),
          null,
          null,
          null,
          (v) => (changed.forward.from.name = v),
          (v) => (changed.forward.from.address = v),
          (v) => (changed.forward.subject = v),
          (v) => (changed.forward.date = v),
        ];
        slots[i](value);
      };
      set(`x${c}y`);
      assert.equal(mailHasHidden(changed), true, `web ${i} ${JSON.stringify(c)}`);
      assert.equal(mailTelegramApprovable(changed), false, `server ${i}`);
    }
  }
});

test("server and web read the HTML state alike", () => {
  for (const p of [
    {},
    { html: { part: "1.2" } },
    { forward: { htmlIncluded: true }, html: { part: "1.2" } },
    { forward: { htmlIncluded: false, htmlOmitted: true } },
    { forward: { htmlIncluded: false, htmlOmitted: false } },
  ])
    assert.equal(webHtmlState(p), serverHtmlState(p), JSON.stringify(p));
  assert.equal(serverHtmlState({ html: { part: "1.2" } }), "draft");
  assert.equal(serverHtmlState({ forward: { htmlIncluded: true } }), "kept");
  assert.equal(serverHtmlState({ forward: { htmlOmitted: true } }), "omitted");
  assert.equal(serverHtmlState({}), null);
});
