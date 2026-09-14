import http from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/** Loopback-only, credential-free provider. It never asks the CLI to execute tools. */
export async function createProbeProvider() {
  const events = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const messages = parsed.messages || parsed.input || [];
    const promptText = (Array.isArray(messages) ? messages : [])
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : (message.content || [])
              .map((part) => part.text)
              .filter((text) => typeof text === "string"),
      )
      .join("\n");
    const marker = (promptText.match(/AP_PROBE_[A-Z0-9_]+/g) || []).at(-1);
    const payloads = (Array.isArray(messages) ? messages : [])
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : (message.content || [])
              .map((part) => part.text)
              .filter((text) => typeof text === "string"),
      )
      .filter((text) => /AP_PROBE_(?:MULTILINE|LONG)/.test(text))
      .map((text) => ({
        marker: text.match(/AP_PROBE_(?:MULTILINE|LONG)/)?.[0],
        length: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      }));
    events.push({
      kind: "request",
      marker,
      at: performance.now(),
      imageCount: (Array.isArray(messages) ? messages : [])
        .filter((message) => message.role === "user")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => ["image", "input_image"].includes(part.type)).length,
      payloads: request.url.includes("count_tokens") ? [] : payloads,
    });
    if (request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"input_tokens":10}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data = {}) => {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    const anthropic = request.url.includes("messages");
    if (anthropic) {
      emit("message_start", {
        message: {
          id: "msg_probe",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
    } else {
      emit("response.created", {
        response: {
          id: "resp_probe",
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
    }
    if (marker === "AP_PROBE_HOLD") await sleep(8000);
    const answer = `Synthetic response complete: ${marker || "auxiliary"}.`;
    if (anthropic) {
      emit("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: answer },
      });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      emit("message_stop");
    } else {
      const item = {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      };
      emit("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      emit("response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: answer,
      });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", {
        response: {
          id: "resp_probe",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
    }
    events.push({ kind: "complete", marker, at: performance.now() });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    events,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
