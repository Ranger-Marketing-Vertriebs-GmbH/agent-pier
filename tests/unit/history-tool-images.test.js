import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCodexRecords,
  normalizeOpenCode,
} from "../../server/features/chat/history-parsers.js";

const DATA = "A".repeat(100 * 1024);
const png = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: DATA },
};
const mcpPng = { type: "image", mimeType: "image/png", data: DATA };
const assistant = (id, content) => ({
  type: "assistant",
  uuid: id,
  message: { id, role: "assistant", content },
});
const result = (id, content) => ({
  type: "user",
  uuid: `result-${id}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const call = (id, name, input) =>
  assistant(`message-${id}`, [{ type: "tool_use", id, name, input }]);

test("Claude Read result image moves out of the tool text", () => {
  const input = { file_path: "/tmp/shot.png" };
  const [row] = normalizeClaude([
    call("t1", "Read", input),
    result("t1", [png]),
  ]).messages;
  assert.ok(row.text.includes("[image 1]"));
  assert.ok(!row.text.includes(DATA));
  assert.ok(row.text.length < 1000);
  assert.deepEqual(row.toolImages, [{ mime: "image/png", data: DATA }]);
  assert.equal(row.toolImagePath, "/tmp/shot.png");
});

test("Claude mixed text and image keeps text once and adds a placeholder", () => {
  const [row] = normalizeClaude([
    call("t1", "Read", { file_path: "/a.png" }),
    result("t1", [{ type: "text", text: "caption" }, png]),
  ]).messages;
  assert.equal(row.text.split("caption").length, 2);
  assert.ok(row.text.endsWith("caption\n\n[image 1]"));
  assert.equal(row.toolImages.length, 1);
});

test("Claude rows without images have no image fields", () => {
  const [row] = normalizeClaude([call("t1", "Read", {}), result("t1", "plain")]).messages;
  assert.equal("toolImages" in row, false);
  assert.equal("toolImagePath" in row, false);
});

test("Claude orphan tool_result extracts images", () => {
  const [row] = normalizeClaude([result("orphan", [png])]).messages;
  assert.equal(row.text, "[image 1]");
  assert.equal(row.toolImages.length, 1);
  assert.equal("toolImagePath" in row, false);
});

test("Codex mcp tool call extracts images", () => {
  const { messages } = normalizeCodex({
    turns: [
      {
        items: [
          {
            id: "m1",
            type: "mcpToolCall",
            tool: "shot",
            arguments: { file_path: "/x.png" },
            status: "completed",
            result: { content: [mcpPng] },
          },
        ],
      },
    ],
  });
  assert.ok(messages[0].text.includes("[image 1]"));
  assert.ok(!messages[0].text.includes(DATA));
  assert.deepEqual(messages[0].toolImages, [{ mime: "image/png", data: DATA }]);
  assert.equal(messages[0].toolImagePath, "/x.png");
});

test("Codex functionCallOutput extracts images", () => {
  const { messages } = normalizeCodex({
    turns: [{ items: [{ id: "f1", type: "functionCallOutput", output: [mcpPng] }] }],
  });
  assert.equal(messages[0].text, "[image 1]");
  assert.equal(messages[0].toolImages.length, 1);
});

test("legacy Codex records extract images when the output is joined", () => {
  const { messages } = normalizeCodexRecords([
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "view",
        arguments: JSON.stringify({ file_path: "/y.png" }),
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: [mcpPng] },
    },
  ]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes("[image 1]"));
  assert.ok(!messages[0].text.includes(DATA));
  assert.equal(messages[0].toolImages[0].data, DATA);
  assert.equal(messages[0].toolImagePath, "/y.png");
});

test("OpenCode tool output extracts images", () => {
  const { messages } = normalizeOpenCode({
    messages: [
      {
        info: { id: "i1", role: "assistant" },
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { file_path: "/z.png" },
              output: [mcpPng],
            },
          },
        ],
      },
    ],
  });
  assert.ok(messages[0].text.includes("[image 1]"));
  assert.ok(!messages[0].text.includes(DATA));
  assert.equal(messages[0].toolImages.length, 1);
  assert.equal(messages[0].toolImagePath, "/z.png");
});

test("OpenCode read attachments become tool images", () => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=";
  const attachment = (id, mime, url) => ({
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime,
    url,
  });
  const { messages } = normalizeOpenCode({
    messages: [
      {
        info: { id: "msg_1", role: "assistant", time: { created: 1 } },
        parts: [
          {
            id: "prt_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "tool",
            callID: "call_1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/shot.png" },
              output: "Image read successfully",
              title: "shot.png",
              metadata: { truncated: false },
              time: { start: 1, end: 2 },
              attachments: [
                attachment("prt_a", "image/png", `data:image/png;base64,${pngBase64}`),
                attachment(
                  "prt_b",
                  "image/svg+xml",
                  "data:image/svg+xml;base64,PHN2Zy8+",
                ),
                attachment("prt_c", "image/png", "https://example.com/x.png"),
                attachment("prt_d", "image/jpeg", `data:image/png;base64,${pngBase64}`),
                attachment("prt_e", "image/png", `data:image/png;base64,${DATA}`),
              ],
            },
          },
        ],
      },
    ],
  });
  const [row] = messages;
  assert.equal(row.role, "tool");
  assert.ok(row.text.includes("Image read successfully"));
  assert.ok(row.text.endsWith("[image 1]\n[image 2]"));
  assert.ok(!row.text.includes(pngBase64));
  assert.ok(!row.text.includes(DATA));
  assert.deepEqual(row.toolImages, [
    { mime: "image/png", data: pngBase64 },
    { mime: "image/png", data: DATA },
  ]);
  assert.equal(row.toolImagePath, "/repo/shot.png");
});
