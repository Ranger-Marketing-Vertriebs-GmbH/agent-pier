import test from "node:test";
import assert from "node:assert/strict";
import { attachmentTargets } from "../../server/features/assistants/team-plugin/tool-guard.js";
import {
  INBOUND_MEDIA,
  inboundMedia,
} from "../../server/features/assistants/team-plugin/inbound-media.js";

const scope = { roots: ["/w"], agentId: "ap-a1" };
const names = (toolName, params) => attachmentTargets(toolName, params, scope);

// OpenClaw decodes a file: path with fileURLToPath, so every spelling it reads as the
// agent's attachments/ folder names that folder's file for the bridge.
test("a file: URL into attachments/ names its file in every spelling", () => {
  for (const value of [
    "file:///w/a1/attachments/x.pdf",
    "file://localhost/w/a1/attachments/x.pdf",
    "FILE:///w/a1/attachments/x.pdf",
    "file:///w/a1/%61ttachments/x.pdf",
    "file:///w/a1/%61TTACHMENTS/x.pdf",
    "file:///w/a1/attachments/%78.pdf",
    "file:///w/a1/memory/%2E%2E/attachments/x.pdf",
    "file:///w/a1/memory/%2e%2e/%61ttachments/x.pdf",
    "file:///w/a1/./attachments/x.pdf",
    "file:///w/a1/attachments%5Cx.pdf",
    "@file:///w/a1/%61ttachments/x.pdf",
    " file:///w/a1/%61ttachments/x.pdf ",
  ])
    for (const [tool, params] of [
      ["read", { path: value }],
      ["memory_get", { file_path: value }],
      ["view_image", { image: value }],
      ["pdf", { pdfs: ["notes.pdf", value] }],
      ["write", { filePath: value, content: "x" }],
    ])
      assert.ok(names(tool, params).includes("x.pdf"), `${tool} ${value}`);
});

test("a file: URL to the attachments folder itself or elsewhere stays unresolved", () => {
  assert.deepEqual(names("read", { path: "file:///w/a1/%61ttachments" }), [""]);
  // Another agent's folder or a host outside the workspaces root is never a name of
  // this agent's, and a path that stays out of attachments/ names nothing there.
  assert.deepEqual(names("read", { path: "file:///w/a2/%61ttachments/x.pdf" }), [""]);
  assert.deepEqual(names("read", { path: "file:///w/a1/notes/%78.md" }), []);
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments.md" }), []);
});

test("an undecodable file: value is judged as written", () => {
  // fileURLToPath refuses an encoded "/" and a foreign host; OpenClaw cannot read
  // either, and the written form still counts when it names attachments/.
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments%2Fx.pdf" }), []);
  assert.deepEqual(names("read", { path: "file://host/w/a1/attachments/x.pdf" }), [""]);
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments/x%2F.pdf" }), [""]);
});

// OpenClaw's inbound media name no chat: every spelling of one asks the bridge with
// INBOUND_MEDIA, which only an agent that is not shared may use.
test("inbound media and media:// references name INBOUND_MEDIA", () => {
  for (const value of [
    "media/inbound/openclaw-staged-1/input-a.png",
    "./Media/INBOUND/openclaw-staged-1/input-a.png",
    "media//inbound/x.png",
    "media\\inbound\\x.png",
    "notes/../media/inbound/x.png",
    "media/x/../inbound/x.png",
    "/w/a1/media/inbound/x.png",
    "/data/state/media/inbound/x.png",
    "file:///w/a1/media/%69nbound/x.png",
    "media://inbound/x.png",
    " MEDIA://inbound/x.png",
    "MEDIA: media://inbound/x.png",
    "MEDIA:/data/state/media/inbound/x.png",
    "media/inbound",
  ])
    assert.deepEqual(names("read", { path: value }), [INBOUND_MEDIA], value);
  for (const value of [
    "media/x.png",
    "inbound/x.png",
    "media/inbounds/x.png",
    "MEDIA:x.png",
  ])
    assert.deepEqual(names("read", { path: value }), [], value);
  assert.equal(inboundMedia(7), false);
});
