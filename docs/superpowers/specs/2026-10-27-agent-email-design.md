# Email access for agents (step 1: IMAP/SMTP)

## Intent

The owner wants an agent to check a mailbox for new mail, tell the owner what
matters, prepare drafts, and send mail — sending only with the owner's approval or
where the owner explicitly allowed it. Needed soon. Step 1 covers any IMAP/SMTP
mailbox, including the owner's private Gmail through IMAP/SMTP with an app password.
Step 2 (separate ticket) adds OAuth: Gmail API and Microsoft 365 via Graph.

Earlier tickets AGENTPIER-15 (Gmail) and AGENTPIER-16 (Microsoft 365 calendars) were
cancelled; this is a fresh start.

## Goals

1. **Mail accounts (owner only):** add an IMAP/SMTP account under the existing
   connections area (host, port, TLS mode, username, password/app password; SMTP
   host/port/TLS; display name and from address). Presets for Gmail
   (`imap.gmail.com:993` TLS, `smtp.gmail.com:465` TLS, app-password hint) and a
   generic preset. A **Test connection** checks login on both. Passwords are stored
   like other secrets (sealed, never returned to the browser, never in logs, backups
   sealed like other secrets).
2. **Grant per agent:** in the agent's **Access**, the owner grants one or more mail
   accounts to an agent, with a level: **Read** (list/read/search mail, mark
   read/unread, move/archive, save drafts) or **Read and send** (adds sending). No
   access by default. Agents of restricted users can be granted mail by the owner
   only; users never grant it.
3. **Agent tool `agentpier_mail`** with actions: `accounts` (granted accounts),
   `list` (new/unread or by folder, bounded, newest first, with a cursor),
   `read` (one message: headers, text body with HTML converted to text, attachment
   names and sizes; bounded size), `search` (IMAP search: from/to/subject/since/
   unseen), `mark` (read/unread/flag), `move` (to a folder, incl. archive),
   `draft` (create/update a draft in the mailbox's Drafts folder: to/cc/bcc/
   subject/body/in-reply-to), `send` (send a draft or a new message), `delete`
   (move to Trash; needs approval). Attachments: reading attachment content and
   sending attachments are out of scope for step 1 (names/sizes only).
4. **Sending rules (owner decision):**
   - By default every `send` creates an approval card (agent chat; Telegram with
     buttons when connected; inbox) showing from/to/cc/bcc/subject/body; the mail
     is sent only after the owner approves; declining keeps the draft.
   - Standing exceptions are rules the owner sets in the agent's settings, never
     from chat: allowed recipient addresses/domains — a send whose every recipient (to/cc/bcc)
     matches a rule goes out without approval. *(Claude's call: no thread-based rule in
     step 1, because "any received thread" would let an outside sender unlock sends.)*
   - A chat message is never an approval: sends without a matching rule are decided only on the approval card or its Telegram buttons, like SSH/SFTP approvals. *(Claude's call after the builder check: no existing proof ties a chat message to one draft, and a mail could otherwise trigger a send during an owner turn.)*
5. **Changing the mailbox (Claude's call, owner agreed to "passt so"):** mark and
   move/archive without approval (reversible); `delete` and any move into the
   special Trash or Junk folder only with approval.
6. **New mail:** no push/IDLE in step 1. The owner uses the existing routines
   (e.g. every 15 min) to have the agent check `list` for unseen mail; the tool
   offers an `unseen since last check` cursor per agent+account so routines don't
   re-report. *(Claude's call.)*
7. **Untrusted content:** mail content is untrusted data; tool descriptions and
   instructions say so; instructions inside mail never authorize sends.
8. **Audit:** account create/update/delete/test, grants, each send (approved or by
   rule), delete, with ids/counts only — never addresses, subjects or bodies.

## Who may use mail *(Claude's calls after the builder check)*

- Step 1: only the owner's own agents and permanent team members can be granted mail.
  Agents of restricted users, temporary members and agents with their own Telegram
  bot for other people cannot (same rule as SSH); no lead pass-through.
- Turn kinds: owner turns (web or paired Telegram), routines and hooks may list, read,
  search, mark, move and draft. `send` from any of them goes out only under a matching
  standing rule, otherwise it raises a card. `delete`/Trash moves are refused in
  routines and hooks (they raise nothing) and need a card in owner turns. Forwarded
  content turns and team-member turns get no mail actions.

## Non-goals (step 1)

- OAuth (Gmail API, Microsoft Graph) — step 2 ticket.
- Calendars, contacts.
- Attachment content download / sending attachments.
- IMAP IDLE / push.
- CLIs (coding sessions) using mail.

## Constraints

- Credentials: NOT the agent secret store (it delivers values into the agent's
  workspace). Follow the SFTP password store pattern
  (`server/features/ssh/ssh-password-store.js`, `docs/sftp-access.md` "Storage and
  backups"): server-side 0600 files that never reach an agent, the browser, logs or
  audit, with their own component in passphrase backups with encrypted credentials.
- Network: TLS required by default (implicit TLS or STARTTLS); plaintext only with an
  explicit owner toggle and a warning. Certificate validation on.
- Library: a well-maintained IMAP client and SMTP library (e.g. `imapflow`,
  `nodemailer`) pinned in package-lock; builder confirms licence and maintenance.
- Approval cards reuse the existing action store/approval patterns (SSH/SFTP
  approvals, Telegram buttons, inbox) — no new approval mechanism.
- de + en copy, ui-guide components only, 600-line limit, docs.

## Left to the builder

- Exact page placement of mail accounts (next to existing connections such as SSH /
  GitHub connections) and the agent Access UI shape.
- Bounds (list size, body size), cursor storage, connection pooling/timeouts.
- How "replies in a thread" is proven (In-Reply-To/References matching a message
  in the account's mailbox).

## Tests and docs

- Integration tests against a local IMAP/SMTP test server (e.g. a small in-process
  fake or a dev dependency) — no real mail providers in CI.
- Approval flow (chat, Telegram, inbox), sending rules, restricted users, secrets
  never exposed, audit content.
- Native contract test for the agent tool list and one scripted call.
- Docs: `docs/agents.md` (mail access), a new `docs/mail.md` (accounts, Gmail app
  password how-to, rules, limits), `docs/users.md`, README.
