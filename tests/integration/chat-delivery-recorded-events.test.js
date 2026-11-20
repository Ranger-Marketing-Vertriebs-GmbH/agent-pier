import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeModBridge } from "../../server/features/claude-mod/claude-mod-bridge.js";
import { claudeModReport } from "../../server/features/claude-mod/claude-mod-events.js";
import {
  claudeModAcceptance,
  createChatDelivery,
} from "../../server/application/chat-delivery-wiring.js";
import { rereadable } from "../../web/features/chat/delivery-confirmation.js";

// Claude Code 2.1.329's prompt reports, recorded with the bridge mod (see the note in
// the fixture): replayed after the delivery's own attempt ended, as AgentPier's prompt
// hooks delay them past it.
const recorded = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/chat-delivery/claude-prompt-reports.json", import.meta.url),
    "utf8",
  ),
);
const session = { id: "one", accountId: "fixture", tool: "claude", createdAt: "x" };
const scope = JSON.stringify(["one", "fixture", "claude", "x"]);

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-recorded-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let delivery;
  const mod = new ClaudeModBridge({
    streams: { streamText: () => true, endStream() {}, setStatus() {} },
    ...claudeModAcceptance(() => delivery),
  });
  delivery = createChatDelivery({
    dataDir,
    sessions: {
      get: async () => session,
      withChatInput: (_id, operation) =>
        operation({
          session,
          raw: "",
          recoveryGeneration: "fixture",
          observationGeneration: "fixture",
          write: async (_text, { onPhase }) => {
            for (const phase of ["paste-intent", "pasted", "submit-intent", "submitted"])
              await onPhase(phase);
          },
        }),
    },
    requests: {
      list: async () => ({ requests: [] }),
      hasPending: () => false,
      clearNotice: () => {},
    },
    models: { guardInput: async () => {} },
    retryMs: 10,
  });
  // A copy that reports prompts readies the session's acceptance source.
  const report = (events) =>
    mod.receive(
      session.id,
      claudeModReport({ protocol: 1, prompts: true, events }).events,
      { prompts: true },
    );
  report([{ type: "hello", cli: recorded.cli }]);
  return { dataDir, delivery, report };
}

test("recorded Claude prompt reports confirm their deliveries after the handoff", async (t) => {
  const x = setup(t);
  for (const message of recorded.messages) {
    let text = message.text;
    if (message.image) {
      text = path.join(x.dataDir, message.text);
      fs.writeFileSync(text, "png");
    }
    const deliveryId = randomUUID();
    const sent = await x.delivery.send(session.id, {
      deliveryId,
      deliveryScope: scope,
      text,
      submit: true,
    });
    // The POST answers before the report: the browser learns "accepted" later.
    assert.equal(sent.status, "handed-off", message.label);
    assert.equal(sent.confirmation, "events", message.label);
    for (const { event } of message.reports) x.report([event]);
    const status = await x.delivery.status(session.id, deliveryId, scope);
    assert.equal(status.status, "accepted", message.label);
  }
});

test("a handoff whose transcript row arrived first is still read for its acceptance", () => {
  for (const message of recorded.messages.filter((entry) => entry.transcriptMs)) {
    const acceptedMs = message.reports.find(
      (report) => report.event.type === "prompt.accepted",
    ).ms;
    // The row reaches the chat within a few dozen ms of the report, either way round:
    // a row matched before the acceptance arrived must not end the re-reading.
    assert.ok(Math.abs(message.transcriptMs - acceptedMs) < 250, message.label);
    const item = {
      status: "handed-off",
      confirmation: "events",
      handedOffAt: 0,
      matchedMessageId: "native-row",
    };
    assert.equal(rereadable(item, Math.max(message.transcriptMs, acceptedMs)), true);
  }
});
