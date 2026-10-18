import { detectAttachment } from "./agent-attachment-types.js";
import { MAX_SHARE_BYTES } from "./agent-share-source.js";
import { personalCapabilities } from "./native-capabilities.js";
import { routineOrigin } from "./routine-targets.js";

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
// Failed copies wait 1, 2, 4 … minutes, at most an hour; a newer page is read whole.
const retryMs = 60000;
const maxRetryMs = 3600000;
const pageSize = 50;
const permanent = (reason) => Object.assign(Error(reason), { permanent: true });
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
    // conversation + artifact → { attempts, until }: when a failed copy may run again.
    this.failures = new Map();
  }
  get idle() {
    const s = this.s;
    return s.closed || s.maintenance || s.recovering || !s.runtime.client?.ready;
  }
  now() {
    return this.s.now?.() ?? Date.now();
  }
  /**
   * Copies the images of `messages` (a raw history page) that are not copied yet, for
   * an agent that may create images (its own switch, or its lead's grant). `session`
   * is the session the page came from and `origin` the trusted origin of a routine's
   * run (observeRun); a chat turn's origin is found from its request.
   */
  scan(conversation, messages, { session, origin } = {}) {
    if (this.idle) return [];
    let agent;
    try {
      agent = this.s.store.getAssistant(conversation.assistantId);
    } catch {
      return [];
    }
    if (!personalCapabilities(agent).createImages) return [];
    const now = this.now();
    return generatedImageRefs(messages)
      .filter((ref) => {
        const key = `${conversation.id}:${ref.artifactId}`;
        return (
          !this.running.has(key) &&
          !((this.failures.get(key)?.until || 0) > now) &&
          !this.s.attachments.shared.artifact(conversation.id, ref.artifactId)
        );
      })
      .map((ref) =>
        this.copy(conversation, ref, messages, {
          session: session || conversation.runtimeSessionKey,
          origin,
        }),
      );
  }
  /** After a run of the conversation ended: its newest messages may hold images. */
  async observe(conversation, { session, origin } = {}) {
    if (this.idle) return;
    const page = await this.s.runtime.client.call("chat.history", {
      sessionKey: session || conversation.runtimeSessionKey,
      limit: pageSize,
    });
    await Promise.all(this.scan(conversation, page?.messages || [], { session, origin }));
  }
  /**
   * A finished run in a session no conversation owns: a routine's own run session
   * (agent:<id>:cron:<job>:run:<run>) copies into the chat its routine commits to,
   * and to the Telegram chat it delivers to (native-routines.js runOrigin).
   */
  observeRun(event) {
    const payload = event?.payload;
    if (
      event?.event !== "chat" ||
      !["final", "aborted", "error"].includes(payload?.state)
    )
      return;
    const session = String(payload.sessionKey || "");
    const runtimeAgentId = /^agent:([^:]+):cron:/i.exec(session)?.[1];
    if (!runtimeAgentId || !this.s.routines?.runOrigin) return;
    const agent = this.s.store
      .listAssistants()
      .find(
        (profile) =>
          profile.runtimeAgentId?.toLowerCase() === runtimeAgentId.toLowerCase(),
      );
    const run = agent && this.s.routines.runOrigin(agent, session);
    if (!run) return;
    const origin = routineOrigin(run.binding);
    this.observe(run.conversation, { session, origin }).catch(() => {});
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
  async copy(conversation, ref, messages, { session, origin: runOrigin }) {
    const key = `${conversation.id}:${ref.artifactId}`;
    this.running.add(key);
    const requestId = this.request(conversation, ref, messages);
    const origin = runOrigin ||
      (requestId && this.s.teams?.store?.context(requestId)) || { kind: "unknown" };
    const agent = this.s.store.getAssistant(conversation.assistantId);
    const shares = this.s.shares;
    const target = {
      conversation,
      requestId: requestId || `image:${ref.artifactId}`,
      name: ref.name,
      mirror: shares.leadChat(origin, agent),
      artifactId: ref.artifactId,
      at: ref.timestamp,
    };
    try {
      const client = this.s.runtime.client;
      let download;
      try {
        download = await client.call(
          "artifacts.download",
          { sessionKey: session, artifactId: ref.artifactId },
          { timeoutMs: 30000 },
        );
      } catch (error) {
        // The Gateway no longer holds it: that does not change on a retry.
        throw error?.answered && /not.?found/i.test(`${error.code} ${error.message}`)
          ? permanent("gone")
          : error;
      }
      if (typeof download?.url !== "string" || !download.url.startsWith(mediaPath))
        throw permanent("location");
      const { body } = await client
        .download(download.url, { maxBytes: MAX_SHARE_BYTES })
        .catch((error) => {
          throw error?.tooLarge ? permanent("size") : error;
        });
      // Only an image the bytes prove reaches the chat.
      if (detectAttachment(body, ref.name)?.kind !== "image") throw permanent("type");
      if (this.idle) return null;
      // Copied meanwhile (another scan of the same page): nothing more to do.
      if (this.s.attachments.shared.artifact(conversation.id, ref.artifactId))
        return null;
      const file = await this.s.attachments.share({ ...target, body });
      const telegram = shares.telegram(origin, file, "");
      shares.audit(agent, origin, telegram, undefined, "generated-image");
      this.failures.delete(key);
      this.s.changed?.();
      return file;
    } catch (error) {
      if (error?.permanent) {
        // The chat shows the image as no longer available; it is never tried again.
        this.failures.delete(key);
        this.s.attachments.shared.unavailable(target);
        shares.audit(agent, origin, null, undefined, "generated-image", "failure");
        this.s.changed?.();
        return null;
      }
      // Tried again on a later read, waiting longer each time.
      const attempts = (this.failures.get(key)?.attempts || 0) + 1;
      this.failures.set(key, {
        attempts,
        until: this.now() + Math.min(retryMs * 2 ** (attempts - 1), maxRetryMs),
      });
      return null;
    } finally {
      this.running.delete(key);
    }
  }
}
