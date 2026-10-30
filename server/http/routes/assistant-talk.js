import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { sessionToken } from "../login.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { spokenText, speechLanguages } from "../../features/speech/speech-text.js";
import { SpeechOutputError } from "../../features/speech/speech-output.js";

const refuse = (res, status, code) => res.status(status).json({ code });

/** Whether a talk session may use this chat: the owner's own chats, not archived ones. */
function talkable(assistants, conversationId) {
  if (typeof conversationId !== "string" || !conversationId) return false;
  let conversation;
  try {
    conversation = assistants.store.getConversation(conversationId);
  } catch {
    return false;
  }
  if (typeof conversation.userId === "string" || conversation.archivedAt) return false;
  const agent = assistants.store.getAssistant(conversation.assistantId);
  return !agent.archivedAt && agent.userAccess?.mode !== "own";
}

/**
 * Talk mode (AGENTPIER-291) and the voice that reads replies aloud: the voice settings
 * beside the Deepgram connection (keys are written, never returned), the owner's talk
 * session of this login, and one reply read aloud as MP3. Only agent routes, so a
 * restricted user never reaches them (route-access.js); the reading route is a chat
 * content route under the owner's privacy guard (owner-content-routes.js).
 */
export function assistantTalkRoutes({
  assistants,
  assistantSpeech,
  identity,
  talk,
  speechOutput,
  dictation,
}) {
  const router = Router();
  const holder = (req) => identity.require(sessionToken(req)).hash;
  const owner = (req, res, next) =>
    req.principal?.role === "owner" ? next() : refuse(res, 404, "notFound");
  router.use(["/assistant-talk", "/assistant-speech/voice"], owner, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-speech/voice", (_req, res) =>
    res.json(assistantSpeech.voice.get()),
  );
  router.put("/assistant-speech/voice", (req, res) =>
    res.json(assistantSpeech.voice.save(req.body)),
  );
  // Whether the Talk button works, and why not: speech recognition first, then voice.
  router.get("/assistant-talk", (req, res) => {
    const listening = dictation.status();
    const speaking = speechOutput.status();
    const session = talk.current(holder(req));
    res.json({
      available: listening.available && speaking.available,
      ...(!listening.available
        ? { reason: listening.reason }
        : !speaking.available
          ? { reason: speaking.reason }
          : {}),
      provider: speaking.provider ?? null,
      maxMinutes: Math.round(talk.limits.maxMs / 60000),
      session: session
        ? { id: session.id, conversationId: session.conversationId }
        : null,
    });
  });
  router.post("/assistant-talk", (req, res) => {
    const conversationId = req.body?.conversationId;
    if (!talkable(assistants, conversationId)) return refuse(res, 404, "notFound");
    const listening = dictation.status();
    if (!listening.available) return refuse(res, 409, listening.reason);
    const speaking = speechOutput.status();
    if (!speaking.available) return refuse(res, 409, speaking.reason);
    const started = talk.start(holder(req), conversationId);
    if (started.refused) return refuse(res, 429, started.refused);
    res.status(201).json(started.session);
  });
  // Stop, or a hidden page (sent with keepalive); `id` ends only that session.
  router.delete("/assistant-talk", (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : null;
    res.json({ stopped: talk.stop(holder(req), id) });
  });
  // One agent reply read aloud: named by chat and message, never text from the client.
  router.post(
    "/assistant-conversations/:id/messages/:messageId/speech",
    async (req, res) => {
      const body = req.body;
      const language = body?.language ?? "en";
      if (
        (body !== undefined &&
          (typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "language"))) ||
        !speechLanguages.includes(language)
      )
        throw assistantProblem("invalid");
      if (!talkable(assistants, req.params.id)) return refuse(res, 404, "notFound");
      const text = await assistants.message(req.params.id, req.params.messageId, {
        role: "assistant",
      });
      if (text === null) return refuse(res, 404, "notFound");
      const spoken = spokenText(text, { language });
      if (!spoken) return refuse(res, 422, "empty");
      const aborted = new AbortController();
      res.once("close", () => aborted.abort());
      let audio;
      try {
        audio = await speechOutput.synthesize({
          holder: holder(req),
          text: spoken,
          signal: aborted.signal,
        });
      } catch (error) {
        if (!(error instanceof SpeechOutputError)) throw error;
        return refuse(res, error.status, error.code);
      }
      res.status(200);
      res.set({
        "Content-Type": audio.mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      try {
        await pipeline(audio.stream, res);
      } catch {
        // A stream cut after the headers ends the response; the browser reports it.
        res.destroy();
      }
    },
  );
  return router;
}
