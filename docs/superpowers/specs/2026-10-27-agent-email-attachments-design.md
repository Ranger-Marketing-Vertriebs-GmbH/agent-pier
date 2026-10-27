# Email for agents, step 2: attachments, forwarding and a guided Gmail setup

Ticket: AGENTPIER-265. Builds on step 1 (AGENTPIER-264, IMAP/SMTP), whose spec is
`docs/superpowers/specs/2026-10-27-agent-email-design.md` on branch `feat/agent-email`.
Everything step 1 decided still holds unless this document says otherwise: accounts
under Connections › Email accounts, passwords stored like SFTP passwords, grants per
agent (**Read** and **Read and send**), who may use mail, turn kinds, the tool
`agentpier_mail`, approval cards (chat, Telegram, Inbox), standing recipient rules,
mark/move/delete without approval, mail content treated as untrusted, and audit with
ids only.

This step starts once step 1 is merged. The plan is written against step 1's merged
code.

## Intent

The owner wants an agent that handles mail end to end:

- **Find a document.** "Find the Telekom invoice from September." The agent finds the
  mail, downloads the attachment, keeps it or files it in a project, reads it, and
  shows or sends it to the owner.
- **Send files.** The agent attaches files to a draft or a mail, including files from
  elsewhere on the computer when the owner asks and the agent may read them.
- **Forward.** The agent forwards a received mail together with its attachments.
- **Search content.** Searches also find text inside PDF and Office attachments,
  e.g. "the invoice for 49.99".

The owner also wants Gmail setup to be easy. OAuth was dropped. A self-hosted
AgentPier would need either Google's restricted-scope verification with a yearly
security audit, or each owner creating their own Google Cloud OAuth client, whose
tokens expire after 7 days in testing mode. Both are harder than an app password, so
the app-password setup gets a guided dialog instead.

## Decisions (owner, 2026-10-27)

1. **No OAuth and no Microsoft 365** in this step. Neither is planned further for now.
2. **Guided Gmail app password.** The Gmail preset in the account dialog guides the
   owner:
   - a direct link to Google's app-password page;
   - a note that 2-step verification must be on first, with a link;
   - a paste field that strips the spaces Google shows in the 16-character password;
   - then **Test connection**.
     Generic IMAP accounts are unchanged.
3. **Download attachments.** Allowed at the **Read** level, because nothing leaves the
   mailbox. The agent saves an attachment either to its workspace or to a project
   folder it may write to. It never writes anywhere else.
   - File names are sanitized.
   - An existing file is never overwritten; a numeric suffix is added instead.
   - The content is untrusted data: it is never executed, and instructions inside it
     never authorize anything.
   - Agents without write access to a project can only save to their workspace.
   - **Where a download may land** _(Claude's call after the builder check)_:
     - In the workspace, only under `mail/`, e.g. `mail/<account name>/<file>`.
       Never in `AGENTS.md`, `SOUL.md`, `skills/`, `.agents/`, `attachments/` or
       `.agentpier/`, so a mail can never create a file the agent loads as an
       instruction or a credential.
     - In a project, the reserved paths of SFTP transfers apply: `.git/`, hooks, the
       instruction files and tool configuration listed in `docs/agents.md`.
4. **Attach files to drafts and sends.** The allowed sources follow the file access the
   agent already has:
   - **Shell level Full access:** any file its shell may read. The owner accepts
     this, because such an agent could copy the file into its workspace anyway.
   - **Shell level With approval, or no shell:** its workspace and the project
     folders granted to it. _(Owner decision after the builder check: under With
     approval the agent's shell could not read other files without the owner, so mail
     must not either.)_
   - **Refused for every agent, with or without shell:** `.git` directories,
     AgentPier's data directory (it holds the mail passwords and sealed secrets),
     symbolic links and hard links. These follow the rules of `agentpier_share_file`
     (`server/features/assistants/agent-share-source.js`); links are refused, not
     resolved. _(Claude's call: this is a hard limit for secrets.)_
   - Agents of restricted users never get mail in step 1, and this does not change.
5. **Approval shows the attachments.** The approval card and the Telegram approval
   list each attachment's full source path, name, size and type. The owner approves
   the mail including those attachments. The files are captured when the draft is
   saved, so the bytes approved are the bytes sent; see "Left to the builder".
   _(Claude's calls after the builder check:)_
   - **Re-check at approval.** As in step 1, the grant, the account and also each
     attachment's source rule are checked again when the owner approves. The card is
     cancelled with `ACCESS_CHANGED` when one of them changed in between, for example
     a lowered shell level or a revoked project.
   - **Attachments already in the draft.** A draft whose attachments AgentPier did
     not capture may be sent; step 1's `MAIL_ATTACHMENTS_UNSUPPORTED` no longer
     applies. Examples are a draft the owner made in Gmail and a forward's original
     parts. The card lists such attachments with name, size, type and hash, labelled
     "already in the draft".
   - **Updating a draft.** Updating a draft with `draftUid` keeps its existing
     attachments unless the agent removes them by name.
6. **Recipient rules also cover mail with attachments.** A send whose recipients all
   match the account's rules goes out without approval, wherever its attachments
   come from. The owner accepted this explicitly, including files from outside the
   workspace or projects.
7. **Size limit:** at most 25 MB of attachments per mail, which is Gmail's limit. The
   same 25 MB applies per downloaded attachment. Larger attachments are refused with
   a clear code, never truncated.
8. **Forwarding.** New action `forward` for a received mail (folder and UID).
   - It sends the original's attachments by default and can leave them out.
   - It accepts an optional text above the quoted original and extra attachments.
   - It counts as a send: the same rules apply, either approval or a matching
     recipient rule.
   - _(Claude's call)_ The forward quotes the original as a header block (From,
     Date, Subject, To) followed by its body. Plain text and HTML are both kept when
     the original has them, the HTML only as a quoted part of the new mail and never
     re-rendered by AgentPier.
   - The approval shows that it is a forward, the original's sender, subject and
     date, and every attachment.
9. **Search in attachment content.** Text is extracted from PDF and Office documents
   (`.docx`, `.xlsx`, `.pptx`; plain text and CSV too) so that `search` can match it.
   Step 1 already searches attachment names and `hasAttachment`.
   - **Claude's call:** a new criterion `attachmentText` searches the extracted text
     of attachments of messages matching the other criteria, newest first, within the
     same candidate cap as the attachment-name filter (500). It returns
     `partial: true` when the cap stops it.
   - Extraction runs on demand and is cached per account, folder, UID validity and
     UID, up to a size budget. There is no background indexing of the whole mailbox.
   - _(Claude's call after the builder check)_ One call stops after 60 s or 200 MB of
     attachments downloaded. It then returns `partial: true` with
     `reason: "candidates" | "time" | "bytes"` and `scanned`, and the cache makes the
     next call continue faster.
10. **Read attachment text** through the new `attachment` action with `text`, not
    through `read` _(Claude's call after the builder check: one action for everything
    about one attachment)_. It returns the extracted text of one attachment,
    bounded like a mail body (32,000 characters, marked truncated and untrusted), so
    the agent can answer "what is the amount on the invoice" without saving the file.
    _(Claude's call: this follows from 3 and 9 and avoids a detour through the
    workspace.)_

## Goals

- Tool actions:
  - new `attachment` with `save` (to the workspace or a project path) and `text`;
  - new `forward`;
  - `draft` and `send` gain `attachments: [{ path }]`;
  - `search` gains `attachmentText`.
- Approval card, Telegram approval and Inbox show attachments and forwards.
- Guided Gmail app-password dialog, in German and English.
- Audit records attachment counts and total size only, never names, paths or content.
- Docs: `docs/mail.md` (attachments, forwarding, limits, the Gmail how-to),
  `docs/agents.md`, README.

## Non-goals

- OAuth, the Gmail API, Microsoft 365 or Graph.
- Running, previewing or converting attachments, beyond extracting text.
- Background indexing of whole mailboxes, push or IDLE.
- Calendars and contacts.
- Changing who may use mail, or step 1's turn rules.

## Anti-goals

- An attachment or mail text is never treated as an instruction.
- A file is never sent without the owner either approving it on the card, with its
  path visible, or having set a matching recipient rule.
- A download never writes outside the workspace or a writable project folder, and
  never follows symlinks out of it.
- No silent truncation of a file that is being sent or saved.

## Constraints

- **Agent file access:**
  - Resolving and reading source files reuses the agent's existing file-access rules
    (shell level, project grants), with symlinks resolved and checked.
  - It must not add a new way for agents without shell to read host files.
  - **Claude's call:** "may read" for agents with shell means the same paths their
    shell tools may read under the current shell level. Without shell it means the
    workspace and the granted project folders, read access sufficing.
- **Extraction libraries:** pinned, licence-checked and listed in
  `THIRD_PARTY_NOTICES.md`. They must not use install scripts unless the native
  toolchain already provides for that.
  - Extraction runs in-process with time and memory limits, or in a worker, so a
    hostile PDF cannot hang or crash the server.
  - **Claude's call:** prefer pure-JS libraries.
- **MIME building:** reuse `nodemailer` from step 1. Forwarding attaches the original
  parts unchanged; it does not re-encode them.
- **Copy and UI:** de + en copy, ui-guide components only, the 600-line limit, docs in
  the same PR.
- **Tests:**
  - against the local IMAP/SMTP fakes from step 1;
  - fixtures for PDF, DOCX and XLSX, including malformed and oversized files;
  - path tests for traversal, symlinks and paths outside the allowed sources for an
    agent without shell;
  - a native contract test for the extended tool.

## Left to the builder

- **When a file is captured.** The file is read when the draft is saved, so the
  approval shows exactly what is sent. Re-reading at send time would let the file
  change after approval. **Claude's call:** capture into the draft in the mailbox at
  draft time; the card shows a hash and size.
- **Cache location and size budget** for extracted text: under the data dir, never in
  backups.
- **Exact sanitizing rules** for file names (length, reserved names, Unicode
  normalisation).
- **How the tool reports a project destination:** project id plus relative path.
