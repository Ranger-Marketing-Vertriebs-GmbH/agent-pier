export const dictationCopy = Object.freeze({
  start: "Start dictation",
  stop: "Stop dictation",
  unavailable: "Voice input unavailable",
  connecting: "Connecting the microphone…",
  recording: "Recording. Speak now.",
  finishing: "Finishing the transcript…",
  stopped: "Dictation stopped. The text is in the message field.",
  setup: "Set up speech recognition",
  close: "Close hint",
  reasons: {
    agentsOff:
      "Voice input uses the agents' speech recognition. Turn on agents and add a Deepgram key under Accounts.",
    notConfigured: "Voice input needs a Deepgram key.",
    insecure:
      "Microphone access needs a secure connection. Open AgentPier over HTTPS, for example through Tailscale, or on localhost.",
    unsupported: "This browser cannot record audio for dictation.",
    unknown: "Voice input is not available right now.",
  },
  errors: {
    denied: "Microphone access was denied. Allow it in the browser to dictate.",
    noMicrophone: "No microphone was found.",
    rateLimited: "Too many dictations in a short time. Try again in a few minutes.",
    busy: "Too many dictations are running. Try again shortly.",
    auth: "Deepgram rejected the key. Check it under Accounts.",
    quota: "The Deepgram account has no credit left.",
    upstreamBusy: "Deepgram is busy. Try again shortly.",
    rejected: "Deepgram refused the audio stream.",
    invalid: "The audio stream was invalid.",
    failed: "Voice input stopped unexpectedly.",
    connection: "The connection to AgentPier was lost.",
  },
  ended: {
    limit: (minutes) => `Dictation stopped after ${minutes} minutes.`,
    idle: "Dictation stopped because no audio arrived.",
    replaced: "Dictation continues in another window.",
    closed: "AgentPier is restarting, so dictation stopped.",
  },
});
