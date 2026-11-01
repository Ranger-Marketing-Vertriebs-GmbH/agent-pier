import { createGatewaySession, sessionNotCreated } from "./session-create.js";
import { keepChatOpen, reopenRefusedChat } from "./native-chat-archive.js";
import { backgroundMethod } from "../../team-plugin/background-commands.js";
import { chatTitleMethod, titleTimeoutMs } from "../../team-plugin/chat-title.js";

// Where OpenClaw serves an artifact's bytes once artifacts.download located it.
const mediaPath = "/api/chat/media/outgoing/";
// A generated artifact that is gone for good, at a location AgentPier does not read,
// or too large: `artifactRefusal` names which, and a retry would not change it.
const artifactRefusal = (reason, cause) =>
  Object.assign(new Error(`Artifact ${reason}.`), { artifactRefusal: reason, cause });

/**
 * The sessions sub-port over the supervisor's current Gateway client
 * (agent-runtime.js documents each method). `on(connection)` binds the same methods
 * to the client behind a handle of host.connection(): the supervisor closes a client
 * it replaces, so once a restart came between, a bound call rejects as a call on that
 * closed client always did (gatewayError UNAVAILABLE, status 503) and the new
 * Gateway receives nothing. `clientOf(connection)` finds that client. Session keys keep OpenClaw's own format
 * (`agent:<runtimeAgentId>:…`); AgentPier stores them as opaque strings. Answers are
 * OpenClaw's own: callers read the fields they always read (`session`, `messages`,
 * `sessionInfo`, …).
 */
export function openClawSessions(supervisor, clientOf) {
  return {
    ...sessionsOver(() => supervisor.client),
    on: (connection) => Object.freeze(sessionsOver(() => clientOf(connection))),
  };
}

// The methods over the client `current()` returns at each call.
function sessionsOver(current) {
  // Same arguments as before the port, so the Gateway sees identical requests.
  const call = async (...args) => current().call(...args);
  // chat.history takes only the parameters given.
  const historyParams = (params) =>
    Object.fromEntries(
      ["sessionKey", "messageId", "limit", "offset", "maxChars"]
        .filter((name) => params[name] !== undefined)
        .map((name) => [name, params[name]]),
    );
  return {
    create: async ({ agentId, label }, options) =>
      createGatewaySession(current(), { agentId, label }, options),
    notCreated: (error) => sessionNotCreated(error),
    send: ({ key, turn, idempotencyKey, onLate }) =>
      call("sessions.send", { key, ...turn, idempotencyKey }, { onLate }),
    abort: ({ key, runId }) => call("sessions.abort", { key, runId }),
    wait: ({ runId, waitMs, timeoutMs }) =>
      call("agent.wait", { runId, timeoutMs: waitMs }, { timeoutMs }),
    describe: ({ key }) => call("sessions.describe", { key }),
    async list({ agentId, label }) {
      const listed = await call("sessions.list", {});
      return (
        listed.sessions?.filter(
          (s) =>
            s.label === label &&
            (s.agentId === agentId || s.key?.startsWith(`agent:${agentId}:`)),
        ) || []
      );
    },
    get: ({ key, limit, timeoutMs }) =>
      call("sessions.get", { key, limit }, { timeoutMs }),
    delete: ({ key, deleteTranscript }) =>
      call("sessions.delete", { key, deleteTranscript }),
    keepOpen: async ({ key }) => keepChatOpen(current(), key),
    reopenRefused: async ({ key, error }) => reopenRefusedChat(current(), key, error),
    compact: ({ key, timeoutMs }) => call("sessions.compact", { key }, { timeoutMs }),
    subscribeMessages: ({ key }) => call("sessions.messages.subscribe", { key }),
    history: (params) => call("chat.history", historyParams(params)),
    // The team plugin's count of the session's background commands, and of an
    // OpenClaw completion run under way (whose agent events carry no mark).
    async backgroundRunning({ key }) {
      const answer = await call(backgroundMethod, { sessionKey: key });
      return answer?.running > 0 || answer?.completing > 0;
    },
    // The team plugin's chat title from the agent's own model: `{ title }`, outside
    // any session (team-plugin/chat-title.js).
    title: ({ agentId, message, reply }) =>
      call(
        chatTitleMethod,
        { agentId, message, reply },
        { timeoutMs: titleTimeoutMs + 5000 },
      ),
    async downloadArtifact({ sessionKey, artifactId, maxBytes, timeoutMs }) {
      // One connection for both steps: a location names a file of that Gateway.
      const client = current();
      let located;
      try {
        located = await client.call(
          "artifacts.download",
          { sessionKey, artifactId },
          { timeoutMs },
        );
      } catch (error) {
        // The Gateway no longer holds it: that does not change on a retry.
        throw error?.answered && /not.?found/i.test(`${error.code} ${error.message}`)
          ? artifactRefusal("gone", error)
          : error;
      }
      if (typeof located?.url !== "string" || !located.url.startsWith(mediaPath))
        throw artifactRefusal("location");
      return client.download(located.url, { maxBytes }).catch((error) => {
        throw error?.tooLarge ? artifactRefusal("size", error) : error;
      });
    },
  };
}
