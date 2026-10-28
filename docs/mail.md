# Email for agents

AgentPier can give an agent access to an IMAP/SMTP mailbox: it checks for new mail,
tells you what matters, reads, searches and sorts mail, saves drafts and sends mail.
A mail goes out only after you approve it, or at once when every recipient matches a
rule you set. Any IMAP/SMTP mailbox works, including a private Gmail account with an
app password. OAuth sign-in (Gmail API, Microsoft 365) is not offered yet.

Only the owner adds email accounts and grants them. Only your own agents and
permanent team members can get them; [agents of users](users.md#what-stays-locked),
temporary team members and agents with their own Telegram bot for other people never
do. Coding CLIs have no access to these mailboxes.

## Add an email account

Open **Connections › Email accounts** and choose **Add email account**.

1. Choose the **Provider**: **Gmail** fills in `imap.gmail.com:993` and
   `smtp.gmail.com:465`, both with **TLS**; **Other** starts with ports 993 and 465
   and TLS, and you enter the servers yourself.
2. Enter a **Name** (how AgentPier and the agent call this account), the **Email
   address** and, optionally, a **Display name** (the sender name of sent mail).
3. **Username** is the sign-in name; leave it empty to sign in with the email
   address.
4. Enter the **Password** (for Gmail the **App password**, see below).
5. Under **Servers**, check **IMAP server**, **IMAP port**, **IMAP security**,
   **SMTP server**, **SMTP port** and **SMTP security** (**TLS**, **STARTTLS** or
   **None**).
6. **Save sent mail to the Sent folder** files a copy of each sent mail in the
   mailbox's Sent folder. It is off for Gmail, which files sent mail itself, and on
   for other providers, which usually need it.
7. **Test connection** signs in to both servers (IMAP sign-in and folder list, SMTP
   sign-in) and shows "IMAP: signed in" and "SMTP: signed in" or the reason for each
   side. It changes nothing in the mailbox. You can test before you save.

The list shows each account with its servers and its last test ("Both signed in" or
"Test failed" with the time). A failed last test counts as a problem, and an
unencrypted account as a warning, in the **Connections** hint of the sidebar
**Menu**. Each account's **Used by** lists the agents granted it with their level.
**Delete email account** removes the account and its saved password; agents lose
access at once, any of their sends that still wait for approval are cancelled, and
the mailbox itself stays unchanged.

### Gmail with an app password

Gmail does not accept your normal Google password over IMAP/SMTP. Create an app
password:

1. Turn on 2-Step Verification for your Google account.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   create an app password for AgentPier and copy its 16 characters.
3. In **Add email account**, choose **Gmail** as the provider and paste the app
   password into **App password**.

IMAP is on by default for Gmail. Revoking the app password in your Google account
stops AgentPier's access at once; the next test or agent call then fails with
`MAIL_AUTH_FAILED`.

## Security and unencrypted connections

- **TLS is required.** Both servers use TLS (implicit TLS or mandatory STARTTLS,
  at least TLS 1.2) with certificate validation. A server whose certificate cannot be
  verified fails with `MAIL_TLS_FAILED`; there is no switch to skip the check.
- **Unencrypted only on request.** Security **None** needs **Allow unencrypted
  connection** on the account; without it the account cannot be saved and AgentPier
  refuses to connect (`MAIL_PLAINTEXT_REFUSED`). The form warns that the password and
  every mail then travel readable through the network. Use it only inside a network
  you control.
- **The password stays on the server.** It is stored in its own owner-only file
  under `mail/passwords/` in the data directory, never in the browser, the agent's
  workspace or instructions, a log, an audit record or an error. The form never
  shows it again: leave **Password** empty to keep it.
- **A password is bound to its servers.** Changing the IMAP or SMTP server, port or
  security (also by switching the provider) needs the password again: "Enter the
  password again: a saved password only works with the servers it was saved for." So
  a changed host can never receive the saved password. A test of unsaved changes
  follows the same rule.
- **Mail content is untrusted.** Senders, subjects, bodies, links and attachment
  names are data, never instructions. The agent is told so, every result it reads is
  marked untrusted, and a mail can never allow a send.

## Grant an account to an agent

In the agent's settings, **Access › Email** lists the granted accounts. **Add email
account …** offers the accounts from Connections; pick one or more, choose the level
and save. Each account's **Used by** in Connections offers the same. An agent has no
email access until you grant it.

| Level             | What the agent may do                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**          | List, read and search mail, mark it read, unread, flagged or unflagged, move it (also to the archive), delete it (to Trash) and save drafts. |
| **Read and send** | Also send: without asking to recipients that match a rule, otherwise only after you approve.                                                 |

### Recipient rules

With **Read and send**, **Send without asking to** holds up to 50 rules per account,
one per line:

- an address (`bob@example.com`) matches that address, ignoring case;
- a domain (`example.com`) matches every address at exactly that domain. Subdomains
  (`mail.example.com`) and longer names (`example.com.evil.net`) do not count.

A send goes out without asking only when **every** to, cc and bcc recipient matches a
rule; a single other recipient makes it wait for your approval. Display names never
count, only the address. Rules are set only here, never from a chat. An agent holds at
most 20 email accounts.

## What the agent can do

Agents use the tool `agentpier_mail`. Its instructions name the granted accounts by
name and id (never their addresses) and the pattern: `accounts` → `list` new mail or
`search` → `read` → `mark`, `move` or `draft` → `send`.

| Action     | What it does                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts` | The granted accounts with level and recipient rules.                                                                                                                                                                                            |
| `list`     | A page of a folder (default INBOX), newest first, with a cursor for older mail; with `new: true`, the unseen INBOX mail since the agent's last check.                                                                                           |
| `read`     | One message: headers, the text (an HTML-only mail converted to text) and the attachments' names, types and approximate sizes, never their content. Reading never marks a mail as read.                                                          |
| `search`   | By from, to, subject, text (headers and text), body, attachment name, since (a date), unseen and has-attachment.                                                                                                                                |
| `mark`     | Read, unread, flagged or unflagged.                                                                                                                                                                                                             |
| `move`     | To a folder, or `archive` for the mailbox's archive folder (`\Archive`, Gmail's All Mail, or a folder named Archive).                                                                                                                           |
| `delete`   | Moves mail to the mailbox's Trash folder. Nothing is ever deleted for good: AgentPier never sets `\Deleted` and never expunges.                                                                                                                 |
| `draft`    | Saves a draft (to, cc, bcc, subject, plain-text body, optionally a reply to a message, which sets In-Reply-To and References) in the Drafts folder. Replacing a draft moves the old version to Trash.                                           |
| `send`     | Sends a saved draft or new fields (saved as a draft first, so a declined or failed send keeps it). Only a draft's plain-text part is sent, never an HTML part; a draft with attachments cannot be sent. After a send, the draft moves to Trash. |

Marking, moving, archiving, deleting to Trash and saving drafts need no approval. A
move or delete needs the server's MOVE extension (RFC 6851); without it nothing
changes and the agent gets `MAIL_MOVE_UNSUPPORTED`. AgentPier never falls back to copy
and expunge.

Reading attachment content, sending attachments, calendars, contacts and push
notifications (IMAP IDLE) are not offered.

### Which turns may use mail

| Turn                                                                                                               | Mail                          |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Your own messages in AgentPier or the paired Telegram chat, and work goal continuations                            | All actions the level allows. |
| The agent's routines                                                                                               | All actions the level allows. |
| Hook runs with the hook's **Email** tick                                                                           | All actions the level allows. |
| Forwarded content, team-member turns, a lead's requests, goal turns carrying a member's result                     | None (`MAIL_ORIGIN_REFUSED`). |
| Coding-session wake turns, reminders, check-ins, users' turns, a command's completion run, hooks without **Email** | None (`MAIL_ORIGIN_REFUSED`). |

In every turn that may use mail, a send without a matching rule waits for your
approval; no turn sends past the rules on its own. A routine's result says when mail
was refused ("Email refused: no access or a limit was reached").

The hook tick **Email** is offered only while the agent holds an email grant, is off
by default and lapses with the last grant. An agent cannot propose a hook with it
([hooks](agents.md#hooks)).

## Sending and approvals

A send without a matching rule shows a **Send email?** card in the agent's chat with
the agent, the email access, **From**, **To**, **Cc**, **Bcc**, **Subject** and the
whole **Message**. A long message is shortened: **Send** works only after **Show all**,
so you always see everything that goes out. Hidden characters are shown as codes with
a warning. The same card appears in the Inbox (**Agents** tab), titled with the
account name and the subject.

- **Send** sends exactly what the card shows, once. **Don't send** declines it; the
  draft stays in Drafts.
- With a paired Telegram chat (or a Telegram turn), the card also arrives there with
  From, To, Cc, Bcc, Subject and the whole body, and **Send** and **Don't send**
  buttons. Telegram offers the buttons only for a body of at most 3,000 characters,
  at most 20 recipients and no hidden characters; otherwise it says "Open AgentPier to
  read and approve this email."
- **A chat message is never an approval**, in AgentPier or Telegram. Only the card's
  buttons send.
- A card expires after 24 hours (the draft stays). At most 5 cards of one agent wait
  at once (`MAIL_APPROVAL_LIMIT`).
- Before it sends, AgentPier checks again that the grant still has **Read and send**,
  the account still exists with the same address and the mail is unchanged. If
  anything changed, the card is cancelled and nothing is sent.

### Outcomes

| State on the card                                              | Meaning                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting for you (`awaiting_approval`)                          | The card waits for your decision.                                                                                                                                                                                                                                |
| Sending … (`executing`)                                        | Approved; AgentPier is sending it.                                                                                                                                                                                                                               |
| Sent (`completed`)                                             | The server accepted it. The agent sees `sent`.                                                                                                                                                                                                                   |
| Not sent · draft kept (`declined`)                             | You chose **Don't send**.                                                                                                                                                                                                                                        |
| Expired · draft kept (`expired`)                               | Nobody decided within 24 hours.                                                                                                                                                                                                                                  |
| Cancelled (`cancelled`)                                        | The account was removed or the agent's access changed before the send.                                                                                                                                                                                           |
| Sending failed (`failed`)                                      | The send stopped before the server could accept the mail (sign-in, TLS, unreachable server, plaintext refused). The draft stays.                                                                                                                                 |
| Not known if sent · check Sent before trying again (`unknown`) | AgentPier cannot tell whether the mail went out: the connection broke, timed out or the server answered oddly after the mail was handed over, or every recipient was rejected. Check the Sent folder (and the recipients) before you or the agent send it again. |

AgentPier never retries a send by itself. A send that was in progress when
AgentPier stopped becomes **unknown** at the next start and is never sent again; the
agent gets a follow-up about it.

The agent's call waits up to 110 seconds for your decision. When you decide later, or
a send takes longer, the agent gets the outcome as a separate `mail-result` turn in
the same chat. That turn is attributed data, not a new instruction from you. After a
card for your own turn it may use mail like that turn; after a routine's or a hook's
card it gets no mail actions.

When a card settles, the chat keeps a lasting **Email** note with its state, the email
access, the number of recipients, the subject and, for a failure, its code; never the
body or an address. The Telegram result repeats From, To, Cc, Bcc and Subject with the
outcome, never the body.

### Rule sends

A send whose every recipient matches a rule goes out at once, with no card and no
note. The agent may send at most 30 such mails per hour (`MAIL_SEND_LIMIT`); sends
you approve do not count. AgentPier keeps the newest 200 rule sends per agent.

## Checking new mail

There is no push. `list` with `new: true` returns the unseen INBOX mail that arrived
since the agent's last such call, per agent and account, and moves its cursor. The
first call takes the newest unseen messages as the starting point, so it never floods
the agent with an old inbox; a mail you read in between is no longer unseen and is
not reported. A changed UIDVALIDITY of the INBOX starts over the same way.

Use a [routine](agents.md#routines-reminders-and-check-ins) to check regularly. Ask
the agent in your chat, for example:

> Every 15 minutes: check new mail in "Private" and tell me what matters.

The routine then runs `list` with `new: true`, reads what looks important and writes
its summary into the agent's main chat with a push notification (and to Telegram when
the routine sends there). It sends nothing without a rule or your approval.

## Limits

| What                                  | Limit                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A `list` or `search` page             | 20 messages by default, at most 50                                                               |
| One read message                      | 1 MiB of its text part downloaded, 32,000 characters returned (`truncated: true` beyond)         |
| Attachments listed per message        | 50, names only                                                                                   |
| Attachment-name searches              | at most 500 candidates checked; `partial: true` means narrow the search (for example with since) |
| Recipients per mail                   | 50 per field                                                                                     |
| Body of a draft or send               | 100,000 characters from the agent; a stored draft's plain text up to 1 MiB                       |
| Rule sends                            | 30 per agent per hour                                                                            |
| Waiting approval cards                | 5 per agent, each for 24 hours                                                                   |
| Accounts per agent; rules per account | 20; 50                                                                                           |
| Connection tests                      | 30 per minute for the owner                                                                      |
| Server timeouts                       | 15 s to connect and to greet, 60 s without data on the connection                                |

Each tool call opens its own IMAP connection and closes it afterwards.

## Storage and backups

The accounts live in `mail/accounts.json` in the data directory, the passwords in
owner-only files under `mail/passwords/`, the new-mail cursors and send cards in the
agents' database. Deleting an agent removes its cursors.

An ordinary backup holds no email accounts or passwords. A backup with **Include
encrypted credentials** carries both in the encrypted capsule. An account whose
password could not be read, or an account list that could not be read, is named as
an omission in the plan and manifest. A restore keeps the account ids, so agents'
grants work again. See [Email accounts in backups](backups.md#email-accounts-in-backups).

## Audit

The activity log records, with ids, counts and result codes only (never an address,
host, username, subject, body, rule or password):

- account create, update (the names of changed fields), delete and test (the result
  code of each side);
- grant changes per agent (`assistant.updated` with the added, removed and changed
  account ids and the number of recipient rules), also when an account removal
  revokes them;
- every send (`mail.sent`: the agent, `authorizedBy` rule or approval, the number of
  recipients and a failure's code);
- every move to Trash (`mail.deleted`: the agent and the count), also a replaced or
  sent draft going there.

## Troubleshooting

The agent reports these codes; the form shows the connection ones in plain words.

| Code                           | Meaning and what to do                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_AUTH_FAILED`             | The server refused the sign-in. Check the username and password; for Gmail create a new app password.                                                         |
| `MAIL_TLS_FAILED`              | The certificate could not be verified or the server offers no TLS. Check host, port and security; a self-signed certificate is not accepted.                  |
| `MAIL_UNREACHABLE`             | The server cannot be reached. Check host and port and the network.                                                                                            |
| `MAIL_TIMEOUT`                 | The server did not answer in time. Try again later; for a send, check Sent first.                                                                             |
| `MAIL_PROTOCOL`                | The server answered unexpectedly. Run **Test connection**; for a send, check Sent before sending again.                                                       |
| `MAIL_PLAINTEXT_REFUSED`       | Security **None** without **Allow unencrypted connection**. Choose TLS or STARTTLS, or allow it knowingly.                                                    |
| `MAIL_NOT_GRANTED`             | The agent has no grant for this account (or has a Telegram bot for other people). Grant it under **Access › Email**.                                          |
| `MAIL_SEND_NOT_GRANTED`        | The grant is **Read**. Switch it to **Read and send** if the agent should send.                                                                               |
| `MAIL_ORIGIN_REFUSED`          | The turn may not use mail (see [Which turns may use mail](#which-turns-may-use-mail)). For a hook, tick **Email**.                                            |
| `MAIL_ACCOUNT_UNAVAILABLE`     | The account was removed, or the saved accounts cannot be read. Check **Connections › Email accounts**.                                                        |
| `MAIL_REVOKED`                 | You changed the agent's access while it was working. Nothing was sent.                                                                                        |
| `MAIL_NOT_FOUND`               | The message or folder does not exist (any more).                                                                                                              |
| `MAIL_NO_TRASH`                | The mailbox has no Trash folder (`\Trash`), so nothing was deleted. Create one, or have the server mark it.                                                   |
| `MAIL_NO_ARCHIVE`              | The mailbox has no archive folder. Create a folder named Archive, or let the agent move to a named folder.                                                    |
| `MAIL_NO_DRAFTS`               | The mailbox has no Drafts folder (`\Drafts`), so no draft was saved and nothing was sent.                                                                     |
| `MAIL_MOVE_UNSUPPORTED`        | The server lacks the MOVE extension (RFC 6851), so nothing was moved or deleted. AgentPier has no copy-and-expunge fallback; use a server that supports MOVE. |
| `MAIL_SEARCH_UNSUPPORTED`      | The server cannot search for non-ASCII text. The agent searches again with ASCII-only words, or narrows by from, since or unseen.                             |
| `MAIL_DRAFT_UNSUPPORTED`       | The draft has no plain-text part or more than 1 MiB of text. The agent saves a new plain-text draft, or you send it yourself.                                 |
| `MAIL_ATTACHMENTS_UNSUPPORTED` | The draft has attachments, which agents cannot send. Send it yourself from your mail program.                                                                 |
| `MAIL_QUERY_EMPTY`             | A search without any criterion.                                                                                                                               |
| `MAIL_APPROVAL_LIMIT`          | 5 of the agent's sends already wait. Decide them in the chat or the Inbox.                                                                                    |
| `MAIL_SEND_LIMIT`              | The agent made 30 rule sends in the last hour. Wait, or approve sends individually.                                                                           |
| `MAIL_CATALOG_UNREADABLE`      | `mail/accounts.json` cannot be read (Connections shows "The saved email accounts cannot be read."). Restore it from a backup.                                 |
| `MAIL_TEST_RATE_LIMITED`       | More than 30 connection tests in one minute. Wait a minute.                                                                                                   |

**Not known if sent.** Open the mailbox's Sent folder (or ask a recipient) before you
or the agent send the mail again. AgentPier never resends it.
