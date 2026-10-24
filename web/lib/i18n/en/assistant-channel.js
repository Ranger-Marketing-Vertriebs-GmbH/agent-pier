export const assistantChannelCopy = {
  language: "Language of Telegram notices",
  languageDe: "German",
  languageEn: "English",
  languageHint:
    "Notices written by AgentPier (approvals, team updates, links) use this language. It is taken from this browser when you first connect; pairing again keeps your choice. Notices already queued keep their text; the agent’s own replies are not translated.",
  appUrl: "AgentPier address for links",
  appUrlHint:
    "Telegram notices link back to this address. It is taken from this browser when you connect or pair; leave it empty to send notices without links.",
  ignored: (privateCount, groupCount) =>
    `Ignored messages: ${privateCount} from other private chats, ${groupCount} from groups.`,
  teamNotification: "Team notification",
  fileNotification: "File shared by the agent",
  connected: (chatId) => `Connected to private chat ${chatId}`,
  description:
    "Use this agent’s shared chat from your private Telegram conversation. Replies to Telegram messages return to Telegram.",
  paused: "Paused or awaiting pairing",
  disconnected: "Disconnected",
  failed: "The channel operation could not be completed.",
  token: "Telegram bot token",
  botHint:
    "Create a dedicated bot with BotFather. A bot already used by another service must be disconnected there first.",
  connect: "Connect Telegram",
  pairHint:
    "Open the link and send the start message to pair your private chat. This code expires after ten minutes.",
  pair: "Pair my private chat",
  newPair: "Create a new pairing code",
  pause: "Pause Telegram",
  resume: "Resume Telegram",
  disconnect: "Disconnect bot",
  activity: "Telegram activity",
  voice: "Voice message",
  media: "Photo, video or file",
  retry: "Retry",
  review: "Acknowledge without resending",
  openChat: "Review agent chat",
  title: "Telegram",
  inProgress:
    "Still in progress. A review action appears here if it needs your decision.",
  states: {
    partial: "Partially successful",
    queued: "Queued",
    voice_pending: "Waiting for transcription",
    transcribing: "Transcribing",
    transcription_failed: "Transcription failed",
    dispatching: "Starting agent",
    running: "Agent working",
    model_uncertain: "Agent outcome unknown",
    model_reviewed: "Outcome reviewed in chat",
    outbound: "Waiting to send",
    delivering: "Sending reply",
    delivered: "Delivered",
    delivery_failed: "Delivery failed",
    delivery_uncertain: "Delivery outcome unknown",
    reply_unavailable: "Answer without text",
    failed: "Failed",
    cancelled: "Cancelled",
    reviewed: "Reviewed",
  },
  diagnostics: {
    FILE_UNAVAILABLE: "The shared file is no longer available in AgentPier.",
    FILE_TOO_LARGE: "The shared file is larger than Telegram accepts.",
    CHANNEL_DESTINATION_CHANGED:
      "The chat binding changed. Review this input before continuing.",
    TELEGRAM_CONFLICT: "Another service is polling this bot. Stop it before resuming.",
    TELEGRAM_WEBHOOK:
      "This bot has an existing webhook. Disconnect its other integration first.",
    TELEGRAM_UNAVAILABLE: "Telegram is currently unavailable.",
    TELEGRAM_REJECTED:
      "Telegram rejected the request. Check the bot connection and whether the chat allows messages.",
    TELEGRAM_RATE_LIMIT:
      "Telegram requested a pause. Delivery will resume after the waiting period.",
    MEDIA_TOO_LARGE: "Voice messages are limited to 10 MB and ten minutes.",
    MEDIA_UNSUPPORTED:
      "Nothing in this message could be passed on to the agent. The Telegram chat was told what failed.",
    VOICE_TOO_LONG: "The voice message was too long and was declined before download.",
    TRANSCRIPTION_REJECTED:
      "Deepgram rejected the audio. Deepgram's response is shown below.",
    TRANSCRIPTION_QUOTA:
      "The Deepgram balance or quota is exhausted. Check your Deepgram account.",
    TRANSCRIPTION_RATE_LIMITED:
      "Deepgram still asked to slow down after several attempts. You can retry the transcription later.",
    MEDIA_DOWNLOAD: "The voice message could not be downloaded.",
    SPEECH_NOT_CONFIGURED: "Configure Deepgram in Accounts before transcribing.",
    SPEECH_AUTH: "Deepgram rejected the credential. Update it in Accounts.",
    TRANSCRIPTION_EMPTY: "No speech was recognized.",
    TRANSCRIPTION_FAILED: "Transcription failed. You can retry it explicitly.",
    TRANSCRIPTION_INTERRUPTED:
      "Transcription was interrupted. It was not repeated automatically.",
    MODEL_REQUEST_FAILED: "The agent request failed or was cancelled.",
    MODEL_OUTCOME_UNKNOWN:
      "Review and resolve the unknown request in the agent chat first.",
    REPLY_UNAVAILABLE: "Waiting for the confirmed reply for this request.",
    REPLY_TOO_LARGE:
      "The reply exceeds the Telegram delivery limit for this integration.",
    REPLY_WITHOUT_TEXT:
      "The agent finished without a text answer. Review it in the agent chat; nothing was sent to Telegram.",
    CHANNEL_QUEUE_FULL:
      "The Telegram queue is full. New messages are declined until queued inputs are processed or reviewed.",
    DECISION_FAILED:
      "A decision from Telegram could not be saved. Decide in AgentPier instead.",
    MODEL_OUTCOME_REVIEWED:
      "The unknown request was reviewed in the agent chat. Nothing was sent to Telegram.",
    CALLBACK_FAILED:
      "A Telegram button press could not be processed. Decide in AgentPier instead.",
    TEAM_NOTIFICATION_FAILED:
      "Telegram notifications for a team could not be prepared. Check the team in AgentPier.",
    DELIVERY_UNCERTAIN:
      "Telegram may have received the reply. Check your chat before acknowledging; nothing will be sent again automatically.",
  },
};
