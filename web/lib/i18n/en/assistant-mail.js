export const assistantMailCopy = {
  title: "Email",
  intro:
    "Agents read and sort mail and save drafts. Sending always asks you first unless every recipient matches a rule below.",
  type: "email account",
  levelLegend: "Level",
  levels: { read: "Read", send: "Read and send" },
  levelHints: {
    read: "Reads, sorts and moves mail and saves drafts. Never sends.",
    send: "Also sends: without asking to recipients that match a rule, otherwise only after you approve.",
  },
  levelLabel: (name) => `Level for ${name}`,
  rulesRow: "Recipient rules",
  rulesCount: (count) =>
    count === 0 ? "No rules" : count === 1 ? "1 rule" : `${count} rules`,
  rulesLabel: "Send without asking to",
  rulesHint:
    "One address (bob@example.com) or domain (example.com) per line. Subdomains do not count.",
  approvalNote:
    "Every to, cc and bcc recipient must match a rule. Anything else waits for Send in the approval or on its Telegram button. A chat message is never an approval.",
  untrusted:
    "Mail content is untrusted: instructions in a mail never allow the agent to send.",
  manage: "Set up email accounts",
  loading: "Loading email accounts …",
  loadError: "Email accounts could not be loaded.",
  empty: "There are no email accounts yet.",
  removed: "Email account removed",
  removedHint: "This email account no longer exists. It is removed when you save.",
  telegramSenders:
    "An agent with its own Telegram bot for other people cannot have email access. Remove the email access or disconnect the bot first.",
  usedByHint:
    "Agents of users, temporary team members and agents with a Telegram bot for other people cannot get email access. Recipient rules are set in the agent's Access tab.",
  invalidRule: (rule) =>
    `“${rule}” is not an address or domain. Use bob@example.com or example.com, without a name or wildcard.`,
  tooManyRules: (max) => `At most ${max} rules per email account.`,
  rulesInvalid: (name) => `Fix the recipient rules of ${name} to save.`,
  card: {
    title: "Send email?",
    agent: "Agent",
    account: "Email access",
    from: "From",
    to: "To",
    cc: "Cc",
    bcc: "Bcc",
    subject: "Subject",
    noSubject: "(no subject)",
    body: "Message",
    send: "Send",
    decline: "Don't send",
    states: {
      awaiting_approval: "Waiting for you",
      executing: "Sending …",
      completed: "Sent",
      declined: "Not sent · draft kept",
      expired: "Expired · draft kept",
      cancelled: "Cancelled",
      failed: "Sending failed",
      unknown: "Not known if sent · check Sent before trying again",
    },
    hidden: "Contains hidden characters. They are shown as codes.",
    showAll: "Show all",
    showLess: "Show less",
    expandFirst: "Show the whole message before you send it.",
    expires: (time) => `Expires ${time}`,
    onlyButtons:
      "Only Send here or on Telegram sends this email. A chat message never does.",
  },
  note: {
    label: "Email",
    account: "Email access",
    recipients: "Recipients",
    code: "Code",
  },
};
