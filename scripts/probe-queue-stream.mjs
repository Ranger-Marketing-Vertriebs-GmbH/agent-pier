import { nativeDeliveryStates } from "../web/features/chat/native-delivery-state.js";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { applyChatSync } from "../web/features/chat/chat-sync.js";
import { inputHash } from "../server/features/chat/native-input-queue.js";

export async function startQueueStreamProbe({ fixture, session, env, snapshot }) {
  const accounts = fixture.application.accounts;
  const original = accounts.environment.bind(accounts);
  accounts.environment = (id) => (id === session.accountId ? env : original(id));
  const manager = fixture.application.sessions;
  if (process.argv.includes("--narrow-queue"))
    await manager.tmux([
      "resize-window",
      "-t",
      manager.target(session.id),
      "-x",
      "50",
      "-y",
      "35",
    ]);
  await delay(100);
  const initial = await snapshot();
  const ws = new WebSocket(
    `${fixture.url.replace("http:", "ws:")}/api/sessions/${session.id}/chat-stream`,
    { origin: fixture.url, headers: { cookie: fixture.cookie } },
  );
  let current, error, originalReceipt;
  const seen = [];
  ws.on("error", (value) => {
    error = value;
  });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.type === "sync") {
      current = applyChatSync(current, message.data);
      seen.push(current.nativeInput);
    }
  });
  const until = async (predicate) => {
    const end = Date.now() + 5000;
    while (!predicate(current)) {
      if (error) throw error;
      assert.ok(
        Date.now() < end,
        `Native queue stream timed out: ${JSON.stringify({ input: current?.nativeInput, availability: current?.availability, messages: current?.messages })}`,
      );
      await delay(25);
    }
  };
  return {
    close: () => ws.terminate(),
    async queued(receipt) {
      originalReceipt = receipt;
      if (process.argv.includes("--narrow-queue"))
        console.log("QUEUE_NARROW_FRAME", JSON.stringify(await snapshot()));
      await until((data) =>
        data?.nativeInput?.queue.includes(inputHash("AP_PROBE_SECOND")),
      );
      assert.equal(current.nativeInput.generation, receipt.observation.generation);
      assert.equal((await snapshot()).pane.width, initial.pane.width);
      assert.equal((await snapshot()).pane.height, initial.pane.height);
      if (session.tool === "opencode") {
        await until((data) =>
          data?.messages.some((row) => row.text === "AP_PROBE_SECOND"),
        );
        assert.equal(
          current.messages.find((row) => row.text === "AP_PROBE_SECOND").inputConsumed,
          undefined,
        );
      }
    },
    async additional(send) {
      if (!process.argv.includes("--multi-queue")) return;
      await send("AP_PROBE_THIRD");
      await until((data) =>
        data?.nativeInput?.queue.includes(inputHash("AP_PROBE_THIRD")),
      );
      await send("AP_PROBE_SECOND");
      await until(
        (data) =>
          data?.nativeInput?.queue.filter((hash) => hash === inputHash("AP_PROBE_SECOND"))
            .length === 2,
      );
      console.log(
        "QUEUE_MULTIPLE_PROBE",
        JSON.stringify({ tool: session.tool, distinct: true, duplicates: true }),
      );
    },
    async consumed() {
      await until(
        (data) =>
          data?.nativeInput &&
          !data.nativeInput.queue.includes(inputHash("AP_PROBE_SECOND")),
      );
      await until((data) =>
        data?.messages.some(
          (row) =>
            row.role === "user" &&
            row.text === "AP_PROBE_SECOND" &&
            (session.tool !== "opencode" || row.inputConsumed),
        ),
      );
      if (!process.argv.includes("--multi-queue")) {
        const states = nativeDeliveryStates(
          [
            {
              id: originalReceipt.deliveryId,
              text: "AP_PROBE_SECOND",
              status: "handed-off",
              baselineIds: [],
              observation: originalReceipt.observation,
            },
          ],
          current.messages,
          current.nativeInput,
          session.tool,
        );
        assert.equal(
          states.get(originalReceipt.deliveryId)?.state,
          "nativeAccepted",
          "Production presentation confirms only fresh native consumption",
        );
      }
      assert.ok(
        seen.some((input) => input?.queue.includes(inputHash("AP_PROBE_SECOND"))),
      );
      await manager.tmux([
        "resize-window",
        "-t",
        manager.target(session.id),
        "-x",
        "120",
        "-y",
        "35",
      ]);
      console.log(
        "QUEUE_STREAM_PROBE",
        JSON.stringify({
          tool: session.tool,
          websocketQueue: true,
          nativeConsumption: true,
          unchangedSize: true,
          width: initial.pane.width,
        }),
      );
    },
  };
}
