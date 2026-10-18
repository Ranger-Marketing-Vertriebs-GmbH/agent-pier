import { detectAttachment } from "./agent-attachment-types.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";

// OpenClaw 2026.10.3 runs image_generate in the background. When the provider is
// done, a completion turn of the same session writes an assistant message whose
// content holds one block per image:
//   { type: "image", artifactId: "artifact_managed_image_<uuid>", alt, mimeType, … }
// and artifacts.download answers with a short-lived, ticketed path on the Gateway's
// own HTTPS origin. The completion's run id names the background task
// (`image_generate:tool:image_generate:<task>:ok:…`), and the tool result of the turn
// that asked for it names the same task, so the image belongs to that turn's request.
const artifactPattern = /^artifact_managed_image_[0-9a-f-]{36}$/;
const taskPattern = /tool:image_generate:([0-9a-f-]{36})/;
const mediaPath = "/api/chat/media/outgoing/";
const retryMs = 60000;
const imageName = (alt) =>
  typeof alt === "string" && /\.(png|jpe?g|webp|gif)$/i.test(alt.trim())
    ? alt.trim()
    : "image.png";
const blocks = (message) => (Array.isArray(message?.content) ? message.content : []);
const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : blocks(message)
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");

/** The generated images among raw OpenClaw history messages, oldest first. */
export function generatedImageRefs(messages = []) {
  const refs = [];
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const task = taskPattern.exec(String(message.__openclaw?.runId || ""))?.[1] || null;
    for (const block of blocks(message))
      if (block?.type === "image" && artifactPattern.test(String(block.artifactId)))
        refs.push({
          artifactId: block.artifactId,
          name: imageName(block.alt),
          timestamp: Number(message.timestamp) || null,
          task,
        });
  }
  return refs;
}

/**
 * Images agents create reach the owner like files they share (agent-share-store.js):
 * AgentPier copies each generated image out of the Gateway into the share store of
 * the chat it was made in, once, shown in place in the history and, when the turn
 * that asked for it came from the owner's Telegram chat, sent there too. A member's
 * image also appears in its lead's chat. The agent does nothing for it.
 */
export class GeneratedImages {
  constructor(service) {
    this.s = service;
    this.running = new Set();
    // conversation + artifact → when a failed copy may be tried again.
    this.failures = new Map();
  }
  get idle() {
    const s = this.s;
    return s.closed || s.maintenance || s.recovering || !s.runtime.client?.ready;
  }
  /** Copies the images of `messages` (a raw history page) that are not copied yet. */
  scan(conversation, messages) {
    if (this.idle) return [];
    const now = this.s.now?.() ?? Date.now();
    return generatedImageRefs(messages)
      .filter((ref) => {
        const key = `${conversation.id}:${ref.artifactId}`;
        return (
          !this.running.has(key) &&
          !((this.failures.get(key) || 0) > now) &&
          !this.s.attachments.shared.artifact(conversation.id, ref.artifactId)
        );
      })
      .map((ref) => this.copy(conversation, ref, messages));
  }
  /** After a run of the conversation ended: its newest messages may hold images. */
  async observe(conversation) {
    if (this.idle) return;
    const page = await this.s.runtime.client.call("chat.history", {
      sessionKey: conversation.runtimeSessionKey,
      limit: 20,
    });
    await Promise.all(this.scan(conversation, page?.messages || []));
  }
  // The request whose turn asked for the image, from the task its tool result names.
  request(conversation, ref, messages) {
    if (!ref.task) return null;
    const asked = messages.find(
      (m) =>
        m?.role === "toolResult" &&
        m.toolName === "image_generate" &&
        textOf(m).includes(`tool:image_generate:${ref.task}`),
    );
    const runId = asked?.__openclaw?.runId;
    if (typeof runId !== "string") return null;
    return this.s.ledger.attemptRequests(conversation.id).get(runId) || null;
  }
  async copy(conversation, ref, messages) {
    const key = `${conversation.id}:${ref.artifactId}`;
    this.running.add(key);
    try {
      const client = this.s.runtime.client;
      const download = await client.call(
        "artifacts.download",
        { sessionKey: conversation.runtimeSessionKey, artifactId: ref.artifactId },
        { timeoutMs: 30000 },
      );
      if (typeof download?.url !== "string" || !download.url.startsWith(mediaPath))
        throw Error("Unexpected media location");
      const { body } = await client.download(download.url, { maxBytes: MAX_SHARE_BYTES });
      // Only an image the bytes prove reaches the chat.
      if (detectAttachment(body, ref.name)?.kind !== "image") throw Error("Not an image");
      if (this.idle) return null;
      const requestId = this.request(conversation, ref, messages);
      const origin = (requestId && this.s.teams?.store?.context(requestId)) || {
        kind: "unknown",
      };
      const agent = this.s.store.getAssistant(conversation.assistantId);
      const shares = this.s.shares;
      // Copied meanwhile (another scan of the same page): nothing more to do.
      if (this.s.attachments.shared.artifact(conversation.id, ref.artifactId))
        return null;
      const file = await this.s.attachments.share({
        conversation,
        requestId: requestId || `image:${ref.artifactId}`,
        name: ref.name,
        body,
        mirror: shares.leadChat(origin, agent),
        artifactId: ref.artifactId,
        at: ref.timestamp,
      });
      const telegram = shares.telegram(origin, file, "");
      shares.audit(agent, origin, telegram, undefined, "generated-image");
      this.failures.delete(key);
      this.s.changed?.();
      return file;
    } catch {
      // Tried again on a later read; a lasting failure costs one call a minute.
      this.failures.set(key, (this.s.now?.() ?? Date.now()) + retryMs);
      return null;
    } finally {
      this.running.delete(key);
    }
  }
}
