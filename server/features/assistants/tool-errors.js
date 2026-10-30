// Agent tools return a stable code and a fixed English reason the model can act
// on. Problem texts are owner-facing German UI copy and may name internals, so
// they never reach the model; only real transport or runtime failures read as
// "unavailable".
import { reportLimits } from "./member-reports.js";
import { loopGuardCaps } from "./agent-loop-guard.js";
const reasons = {
  TELEGRAM_NOT_CONNECTED:
    "No Telegram chat is paired for this person. Ask them to pair Telegram in the agent settings first; retrying does not help until then.",
  TELEGRAM_UNAVAILABLE:
    "Telegram delivery is not available to this person on this agent: only the owner, or a user on her own agent with Extended access, can pair a Telegram chat. Do not retry; results still reach this chat with a push notification.",
  INVALID_TIME:
    "Give the time as an ISO timestamp with a UTC offset or Z, for example 2026-10-09T09:00:00+02:00.",
  INVALID_INPUT:
    "The parameters were rejected. Check required fields and use IDs returned by catalog, list or status.",
  MCP_SERVER_NOT_BOUND:
    "mcpServers may only name MCP servers bound to you (the prefix before __ in your MCP tool names). Remove the other names and propose again.",
  TEAM_GRANT_NOT_HELD:
    "You can only grant a member tools, skills, MCP servers and access that you hold yourself. Shell and SSH also need the owner's setting 'Team members may use shell and SSH', and never more than your own shell level. Remove that grant and try again.",
  ROUTINE_MEMBER_NOT_PERMANENT:
    "Routines can only be set up on your own permanent members; temporary members work only on their task. Ask the owner to keep the member as a permanent agent first.",
  ROUTINE_MEMBER_OFF:
    "This member has routines switched off in its settings. Do not retry; ask the owner to switch them on.",
  MEMBER_NOT_RUNNING:
    "Grants are only for your own task members that are not archived, and shares only for your own permanent members. Check agentpier_team_members for the memberId.",
  FORBIDDEN:
    "This action is not permitted for this agent in the current turn. Do not retry; explain this to the owner.",
  TURN_UNCONFIRMED:
    "AgentPier has not yet confirmed that this turn started (the Gateway acknowledged it late). This is temporary: wait about 5 seconds and retry the same call, at most 3 times; if it still fails, tell the owner.",
  NOT_FOUND:
    "The referenced item does not exist or is not accessible. Use catalog, list or status to find valid IDs.",
  CONFLICT:
    "The item changed or this call conflicts with an earlier one. Read the current state and retry with the current revision.",
  BUSY: "Another operation is still active, for example a running team or a pending request. Check its status instead of retrying.",
  REVIEW_REQUIRED:
    "It is unclear whether this was already created. Ask the owner to check the agent settings before retrying.",
  MODEL_UNAVAILABLE:
    "The model connection of this agent is not available. Ask the owner to choose a model connection.",
  TASK_OPEN:
    "This member already has an open task. Wait for its result or cancel it with agentpier_team_cancel.",
  MEMBER_NOT_FINISHED:
    "Only your finished temporary members without open questions or tasks can be archived. Check agentpier_team_members.",
  PEER_TURN:
    "Questions, tasks and reports to other members are not possible in a turn of forwarded or member content. Do not retry.",
  AGENT_LOOP_LIMIT: `You started ${loopGuardCaps.actions} team, routine, project or SSH proposal actions in the last ${loopGuardCaps.windowMs / 60000} minutes. AgentPier stops here so that no loop runs away. Do not retry now; finish with what you have and tell the owner what is still open.`,
  PEER_OPEN:
    "You already have an open request to this member, or it already works on an open task. Wait for its answer instead of retrying, or report it to your lead with agentpier_team_report.",
  REPORT_TOO_LONG: `A report holds at most ${reportLimits.text} characters, and this one is longer; nothing was sent. Shorten it to the result your lead needs. Put the details into a project file you may write and name it in files, or send the rest as a second report.`,
  TEMPLATE_NOT_FOUND:
    "No Agency agent has this id. Search with agentpier_team_templates and use an id it returned.",
  TEMPLATE_BLOCKED:
    "AgentPier's scan blocked this Agency agent (hidden characters or download-and-run instructions). Choose another template or none.",
  TEMPLATE_TOO_LARGE:
    "This Agency agent is too long to be a member template. Choose another template or none.",
  TEMPLATE_UNAVAILABLE:
    "The Agency catalog cannot be read right now. Propose the member without a template or try later.",
  MEMBER_UNAVAILABLE:
    "This member never started and has no chat to answer in. Choose another member.",
  SSH_NOT_GRANTED:
    "This SSH host is not granted to you. Use agentpier_ssh with action hosts and an accessId from it; ask the owner to grant other hosts.",
  SSH_HOST_UNAVAILABLE:
    "This SSH host is unavailable: it was removed or OpenSSH is missing. Tell the owner; do not retry.",
  SSH_ROUTINE_NOT_TRUSTED:
    "In routines only hosts the owner marked 'Trusted' run commands. Do not retry; say in the routine's result that SSH was refused for this host.",
  SSH_ORIGIN_REFUSED:
    "SSH is not available in this turn: it was not the owner's own request (forwarded, scheduled or member content). Do not retry; tell the owner.",
  SSH_BUSY:
    "Three SSH commands of yours are still running. Wait for one of their results before you start the next one.",
  SSH_APPROVAL_LIMIT:
    "Three of your SSH commands already wait for the owner's approval. Wait for decisions before you request more.",
  SSH_REVOKED:
    "The SSH access changed or the turn ended while the command waited or ran; it was stopped. Do not retry without the owner.",
  SSH_HOST_TYPE:
    "This host does not take this action: an SFTP host takes only the file actions (list, stat, download, upload, sync, mkdir, rename, delete), an SSH host only execute. Check the type in action hosts.",
  SSH_CONSOLE_CONTROL:
    "This host runs commands in its interactive console: send plain lines separated by line breaks, without tabs, carriage returns, escape or other control characters.",
  SFTP_ROUTINE_DELETE:
    "Routines never delete files on SFTP hosts, also not with a sync that deletes extra files. Do not retry; say in the routine's result what you would delete, so the owner can do it.",
  SFTP_APPROVAL_LIMIT:
    "Three of your SFTP file operations already wait for the owner's approval. Wait for decisions before you request more.",
  SFTP_WORKSPACE_REFUSED:
    "In your workspace, SFTP never reads or writes your prompt files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md), skills/, .agents/, attachments/ or top-level names with other than plain ASCII letters, digits and . _ - ( ) + , or spaces, and never downloads or syncs a folder into the workspace itself (a single file with another name may land there). Give localPath as a plain subfolder, for example downloads/site, or another file name.",
  SFTP_AUTH_FAILED:
    "The SFTP server refused AgentPier's sign-in for this host. Do not retry; tell the owner to check the host's password or key in the settings.",
  SFTP_HOST_KEY_MISMATCH:
    "The SFTP server presented a different host key than the one the owner confirmed. Do not retry; tell the owner, the server may have been replaced or intercepted.",
  SFTP_UNREACHABLE:
    "The SFTP server cannot be reached. Retry later once; tell the owner if it persists.",
  SFTP_TIMEOUT:
    "The SFTP operation timed out. Retry once with a smaller transfer; tell the owner if it persists.",
  SFTP_NOT_FOUND:
    "The remote or local path does not exist. Check it with action list or stat (remote) and give an existing path.",
  SFTP_PERMISSION:
    "The SFTP server denied permission for this path. Do not retry the same path; tell the owner which path needs access.",
  SFTP_PATH_REFUSED:
    "This remote path is not allowed: it leaves the host's allowed folder (remoteRoot in action hosts), goes above /, or contains control characters or a backslash. Use a path inside the allowed folder.",
  SFTP_LIMIT:
    "The transfer exceeds AgentPier's limits (2 GiB, 10,000 files, 50,000 scanned entries or a 60 s scan). Transfer a smaller folder, or exclude files.",
  SFTP_TYPE_CONFLICT:
    "A file is where a folder is expected (or the reverse), the folder is not empty, or the rename target exists. Check the paths with list or stat; nothing was changed at that path.",
  SFTP_PLAN_CHANGED:
    "The files changed between the plan and the run, so nothing more was written. Run the action again to plan with the current files.",
  SFTP_JOB_NOT_FOUND:
    "No SFTP job of yours has this jobId. Use the jobId an earlier SFTP call returned.",
  SFTP_BUSY:
    "Another SFTP write of yours runs on this remote folder, or two of your SFTP jobs already run. Check them with action job and retry after they end.",
  SFTP_CANCELLED: "The SFTP job was cancelled. Do not retry unless the owner asks.",
  SFTP_FAILED:
    "The SFTP operation failed. Check the remote state with list or stat before you retry once; tell the owner if it fails again.",
  PROJECT_NOT_GRANTED:
    "This project folder is not granted to you. Your instructions list the project folders you may use; ask the owner (or your lead) for access instead of retrying.",
  PROJECT_READ_ONLY:
    "You may only read this project folder. Do not retry the change; tell the owner (or your lead) what you wanted to change.",
  ROUTINE_WRITES_OWNER_ONLY:
    "'May write' cannot be switched with your routine tool in this chat. Do not retry; ask the owner to switch 'May write' for this routine in the agent settings. The routine still runs and only reads.",
  ROUTINE_READ_ONLY:
    "This routine may only read project folders because 'May write' is off for it, so AgentPier refused the change. This is not a failure of the run: do not retry, do not start your reply with AUTOMATION_FAILED for this, and carry on with the read-only part of the task. In the routine's result, say that 'May write' is off for this routine and which change you would have made, so the owner can switch on 'May write' for it (agent settings, Automation, Routines) or make the change.",
  PERMANENT_ACCESS_ONLY:
    "A permanent member's tools and settings are the owner's. You can only share your project folders (grants.projects), Read images (grants.documents), coding projects (coding) and MCP servers (mcpServers) with it. Remove the other grants and try again.",
  PROJECT_WRITE_UNAVAILABLE:
    "Project folder changes are unavailable until AgentPier has verified the agent runtime's tool guard. Try again in a minute; tell the owner if it persists.",
  PROJECT_PATH_REFUSED:
    "This path is not allowed. Use a path relative to the project folder (or absolute inside it), without '..'; .git internals, links leading out of the folder and AgentPier's own data are never accessible.",
  PROJECT_TOOL_CONFIG_LOCKED:
    "Agents of restricted users may not change tool configuration or CLI instructions in project folders (.claude, .codex, .opencode, opencode.json, .vscode, .mcp.json, .envrc, AGENTS.md, CLAUDE.md, git hook managers and similar), because the owner's tools run or follow them. Do not retry; tell the user which change you wanted so the owner can make it.",
  USER_AGENT_LOCKED:
    "Agents of restricted users cannot use coding, project memory, run actions, shell, SSH, Git or teams; this never changes for this agent. Do not retry; tell the user what you wanted to do so the owner can do it.",
  PROJECT_FILE_UNSUITABLE:
    "This file is binary, hard-linked, not a regular file, too large for this action (edits and search: 1 MiB; appends: 16 MiB in total) or the line range lies too deep (256 MiB). For a PNG, JPEG, GIF or WebP image use image_view; otherwise use files_list, read a line range with file_read, or tell the owner.",
  PROJECT_IMAGE_UNSUITABLE:
    "image_view shows only PNG, JPEG, GIF and WebP images up to 6 MiB, recognized by their content. Read text files with file_read; tell the owner about other files.",
  IMAGES_OFF:
    "Read images is not switched on for you, so you cannot view images. Do not retry; ask the owner (or your lead) to switch on Read images, or describe what you need from the image.",
  MODEL_TEXT_ONLY:
    "Your model cannot take images, so image_view cannot show you this file. Do not retry; tell the owner, who can choose a model that reads images.",
  PROJECT_EDIT_NO_MATCH:
    "oldText must occur exactly once in the file (or set replaceAll). Read the file and copy the exact text, including whitespace.",
  PROJECT_FILE_ENCODING:
    "This file is not valid UTF-8 (for example Latin-1), so it is not changed: an edit would replace characters. Read it, and tell the owner if it must change.",
  PROJECT_WRITE_TOO_LARGE:
    "One file_write may hold at most 64 KiB (UTF-8 bytes). Write the first part, then add the rest with file_write and append: true in further calls.",
  REQUEST_TOO_LARGE:
    "The call was larger than AgentPier accepts (128 KiB). Send the content in smaller parts, for example file_write with append: true.",
  SHARE_NOT_FOUND:
    "No regular file exists at this path in your workspace. Give the path relative to your workspace, for example reports/summary.pdf.",
  SHARE_OUTSIDE:
    "Only regular files inside your own workspace can be shared, never through a symbolic or hard link. Copy the file into your workspace first.",
  SHARE_TOO_LARGE:
    "Shared files are limited to 25 MB. Compress or split the file, or tell the owner where it is.",
  SHARE_EMPTY: "This file is empty; there is nothing to share.",
  BROWSER_NOT_GRANTED:
    "You may not use a browser, so AgentPier stages no file for one. Do not retry; ask the owner (or your lead) to switch on the browser for you.",
  UPLOAD_TOO_LARGE:
    "A file staged for a browser upload may be at most 8 GiB. Do not retry; tell the owner where the file is.",
  UPLOAD_NO_SPACE:
    "There is not enough free disk space, or AgentPier already holds the most staged browser uploads it keeps, to stage this file. Do not retry now; tell the owner.",
  UPLOAD_TIMEOUT:
    "Copying this file for the browser took too long and was cancelled; nothing was staged. Do not retry now; tell the owner where the file is.",
  STORAGE_FULL:
    "AgentPier's storage for this file is full. Do not retry; tell the owner.",
  STORAGE_UNSAFE:
    "AgentPier's storage for shared files is not a plain folder, so nothing can be shared. Do not retry; tell the owner.",
  GOAL_OWNER_ONLY:
    "This needs the owner's own message; a goal continuation cannot do it. Do not retry; tell the owner what you need.",
  GOAL_UNAVAILABLE:
    "Goals are only available in the owner's own chats with this agent. Do not retry.",
  GOAL_NOT_OPEN: "This chat has no open goal. Do not retry.",
  HOOK_RIGHT_EXCEEDS:
    "A hook cannot hold a right you do not have yourself. Remove that right and propose again.",
  HOOK_UNAVAILABLE:
    "Hooks are only available to your owner's own agents and permanent members with reminders and routines switched on. Do not retry; tell the owner.",
  SSH_PROPOSAL_UNAVAILABLE:
    "SSH access proposals are only available to your owner's own agents and permanent members without a Telegram bot for other people. Do not retry; tell the owner.",
  SSH_PROPOSAL_INVALID:
    "Give host as a host name or IP address (no spaces, options or user@ prefix), port as a number from 1 to 65535 and username as letters, digits, _ . and - (not starting with -). Fix the values and propose again.",
  SSH_PROPOSAL_EXISTS:
    "This host, port and user are already an SSH access in AgentPier. Do not propose it again; ask the owner to grant you that access.",
  SSH_PROPOSAL_SCAN_FAILED:
    "AgentPier could not read the host key of this server: it is unreachable from AgentPier, the port is not SSH, or the name does not resolve. Check host and port with the owner; do not retry unchanged.",
  SSH_PROPOSAL_PROJECT:
    "No project has this projectId. Leave projectId out or use one of your project folder ids.",
  SESSIONS_NOT_ENABLED:
    "Coding sessions are not switched on for you on this project (or on any project). Do not retry; ask the owner to switch on coding sessions for the project in your settings.",
  GRANT_REVOKED:
    "The owner removed your access to this coding session: its project, the coding sessions switch or the share it rested on is gone, or you can no longer use sessions. Do not retry and do not use the session again; tell the owner.",
  SESSION_LIMIT:
    "You already run the most coding sessions allowed at a time. Stop a session you no longer need with action stop before you start another.",
  PROMPT_ANSWERED:
    "This prompt was already answered or has changed. Read the open prompts again with action requests and answer the one that is still open.",
  SESSION_RUNNING:
    "The session is still working. Use action wait until it is idle before you send the next prompt or remove its worktree, or stop it if you are done.",
  WORKTREE_DIRTY:
    "The worktree has uncommitted changes, so it was kept. Let the session commit or discard them first, or leave the worktree for the owner.",
  WORKTREE_NOT_MERGED:
    "The worktree branch is not merged into its base branch on origin (a squash merge does not count), so it was kept. Leave it for the owner or merge it first.",
  NO_REPOSITORY:
    "This project folder is not a Git repository with an origin remote, so no worktree can be made. Start with worktree: false to work in the project folder itself, or tell the owner.",
  MAIL_NOT_GRANTED:
    "This email account is not granted to you. Use agentpier_mail with action accounts and an accountId from it; ask the owner to grant other accounts.",
  MAIL_SEND_NOT_GRANTED:
    "You may only read this email account. Do not retry; save a draft with action draft and tell the owner, or ask the owner for the send level.",
  MAIL_ORIGIN_REFUSED:
    "Email is not available in this turn: only the owner's own requests, routines and hooks with the Email tick may use it, never forwarded content, team requests or member results. Do not retry; tell the owner.",
  MAIL_ACCOUNT_UNAVAILABLE:
    "This email account is not available: it was removed or the saved accounts cannot be read. Use action accounts again and tell the owner if it is missing.",
  MAIL_AUTH_FAILED:
    "The mail server refused the login of this account. Do not retry; tell the owner to check the account under Connections.",
  MAIL_TLS_FAILED:
    "The encrypted connection to the mail server failed. Do not retry; tell the owner to check the account under Connections.",
  MAIL_UNREACHABLE:
    "The mail server cannot be reached right now. Try again later and tell the owner if it stays unreachable.",
  MAIL_TIMEOUT:
    "The mail server did not answer in time. Try again later, with a smaller limit if you listed or searched.",
  MAIL_PROTOCOL:
    "The mail server sent an unexpected response. Do not retry unchanged; tell the owner.",
  MAIL_NOT_FOUND:
    "No such message or folder. List the folder again and use a uid and folder from the result.",
  MAIL_NO_TRASH:
    "This mailbox has no Trash folder, so nothing was deleted. Do not retry; tell the owner.",
  MAIL_NO_ARCHIVE:
    "This mailbox has no archive folder, so nothing was moved. Move the mail to a named folder instead or tell the owner.",
  MAIL_NO_DRAFTS:
    "This mailbox has no Drafts folder, so no draft could be saved. Do not retry; tell the owner.",
  MAIL_APPROVAL_LIMIT:
    "Too many of your mail sends already wait for the owner's approval. Do not send more now; tell the owner.",
  MAIL_SEND_LIMIT:
    "You sent the most mail allowed in the last hour. Do not retry now; tell the owner.",
  MAIL_REVOKED:
    "The owner changed your access to this email account. Do not retry; use action accounts again and tell the owner.",
  MAIL_SEARCH_UNSUPPORTED:
    "This mail server cannot search for non-ASCII text. Search again with ASCII-only words, or narrow the search with from, since or unseen.",
  MAIL_MOVE_UNSUPPORTED:
    "This mail server cannot move messages safely, so nothing was moved or deleted. Do not retry; tell the owner.",
  MAIL_DRAFT_UNSUPPORTED:
    "This draft or forward cannot be sent by you: it has no plain-text part or too much text (over 1 MiB, or a forward over 100,000 characters). Save a new plain-text draft with action draft, or tell the owner.",
  MAIL_QUERY_EMPTY:
    "A search needs at least one criterion in query (from, to, subject, text, body, attachment, attachmentText, since, unseen or hasAttachment).",
  MAIL_ATTACHMENT_TOO_LARGE:
    "The attachments are larger than 25 MB, so nothing was saved or sent. Do not retry unchanged; attach fewer or smaller files, or tell the owner.",
  MAIL_DRAFT_CHANGED:
    "The draft changed in the mailbox after it was captured, so nothing was sent and the draft was kept. Do not retry the same send; read the draft again and send it anew, or tell the owner.",
  MAIL_TEXT_UNSUPPORTED:
    "No text can be read from this attachment type; only PDF, DOCX, XLSX, PPTX, text and CSV are read. Do not retry; save it with mode save if you need the file, or tell the owner.",
  MAIL_TEXT_FAILED:
    "The text of this attachment could not be read: it is damaged, encrypted or too complex. Do not retry; save it with mode save if you need the file, or tell the owner.",
  MAIL_BUSY:
    "AgentPier is reading other mail HTML right now, so nothing was saved or sent. Try again in a moment.",
  MAIL_SOURCE_REFUSED:
    "You may not attach this file: it is outside your workspace and granted project folders, or it is a link, inside .git or AgentPier's data. Do not retry; copy the file into your workspace with your own tools only if you may, or tell the owner.",
  MAIL_SOURCE_NOT_FOUND:
    "No such file to attach. Check the path (relative to your workspace, or to the project with projectId) and try again with an existing file.",
  MAIL_SOURCE_EMPTY:
    "This file is empty or not a regular file, so it cannot be attached. Do not retry; attach the file that holds the content, or tell the owner.",
  MAIL_SAVE_REFUSED:
    "You may not save the attachment there: only under mail/ in your workspace or in a project folder you may write to, never in instruction, skill, .git or AgentPier folders. Do not retry the same place; save without projectId and path, or tell the owner.",
  PROJECT_NAME_INVALID:
    "Give name as a plain folder name: no / or \\, no control characters, not . or .., no leading dot, at most 255 bytes. Fix it and try again.",
  PROJECT_EXISTS:
    "The owner's default working directory already has an entry with this name. Pick another name; never reuse an existing folder.",
  PROJECT_NOT_CREATED_BY_YOU:
    "You can switch coding sessions only for projects you created yourself (see action list). Ask the owner for anything else.",
  PROJECT_NOT_ELIGIBLE:
    "Only the owner's own agents that are not team members and have no Telegram bot for other people can create projects. Do not retry; ask your lead or the owner.",
  PROJECT_FOLDER_UNAVAILABLE:
    "AgentPier could not create a separate project in the owner's default working directory: it is missing, not writable or inside another project, or git init failed. Nothing was left behind. Do not retry unchanged; tell the owner.",
  UNAVAILABLE: "AgentPier operation unavailable; inspect its state before retrying.",
};
const byKey = {
  reminderChannelRequired: "TELEGRAM_NOT_CONNECTED",
  reminderTelegramUnavailable: "TELEGRAM_UNAVAILABLE",
  reminderTimezoneRequired: "INVALID_TIME",
  reminderReviewRequired: "REVIEW_REQUIRED",
  routineReviewRequired: "REVIEW_REQUIRED",
  teamMcpServerNotBound: "MCP_SERVER_NOT_BOUND",
  teamGrantNotHeld: "TEAM_GRANT_NOT_HELD",
  teamGrantMemberEnded: "MEMBER_NOT_RUNNING",
  leadRoutineNotPermanent: "ROUTINE_MEMBER_NOT_PERMANENT",
  leadRoutineMemberOff: "ROUTINE_MEMBER_OFF",
  memberRequestOpenTask: "TASK_OPEN",
  memberRequestNotFinished: "MEMBER_NOT_FINISHED",
  memberRequestUnavailable: "MEMBER_UNAVAILABLE",
  peerRequestTurn: "PEER_TURN",
  agentLoopLimit: "AGENT_LOOP_LIMIT",
  peerRequestOpen: "PEER_OPEN",
  memberReportTooLong: "REPORT_TOO_LONG",
  templateNotFound: "TEMPLATE_NOT_FOUND",
  templateBlocked: "TEMPLATE_BLOCKED",
  templateTooLarge: "TEMPLATE_TOO_LARGE",
  templateUnavailable: "TEMPLATE_UNAVAILABLE",
  sshNotGranted: "SSH_NOT_GRANTED",
  sshHostUnavailable: "SSH_HOST_UNAVAILABLE",
  sshRoutineNotTrusted: "SSH_ROUTINE_NOT_TRUSTED",
  sshOriginRefused: "SSH_ORIGIN_REFUSED",
  sshBusy: "SSH_BUSY",
  sshApprovalLimit: "SSH_APPROVAL_LIMIT",
  sshRevoked: "SSH_REVOKED",
  sshHostType: "SSH_HOST_TYPE",
  sshConsoleControl: "SSH_CONSOLE_CONTROL",
  sftpRoutineDelete: "SFTP_ROUTINE_DELETE",
  sftpWorkspaceRefused: "SFTP_WORKSPACE_REFUSED",
  sftpApprovalLimit: "SFTP_APPROVAL_LIMIT",
  projectFolderNotGranted: "PROJECT_NOT_GRANTED",
  projectFolderReadOnly: "PROJECT_READ_ONLY",
  projectRoutineReadOnly: "ROUTINE_READ_ONLY",
  routineWritesOwnerOnly: "ROUTINE_WRITES_OWNER_ONLY",
  teamShareAccessOnly: "PERMANENT_ACCESS_ONLY",
  projectWriteUnavailable: "PROJECT_WRITE_UNAVAILABLE",
  projectPathRefused: "PROJECT_PATH_REFUSED",
  projectToolConfigLocked: "PROJECT_TOOL_CONFIG_LOCKED",
  userAgentLocked: "USER_AGENT_LOCKED",
  projectFileUnsuitable: "PROJECT_FILE_UNSUITABLE",
  projectImageUnsuitable: "PROJECT_IMAGE_UNSUITABLE",
  projectImagesOff: "IMAGES_OFF",
  projectImageModel: "MODEL_TEXT_ONLY",
  projectEditNoMatch: "PROJECT_EDIT_NO_MATCH",
  projectFileEncoding: "PROJECT_FILE_ENCODING",
  projectWriteTooLarge: "PROJECT_WRITE_TOO_LARGE",
  hookRightExceeds: "HOOK_RIGHT_EXCEEDS",
  hookUnavailable: "HOOK_UNAVAILABLE",
  sshProposalUnavailable: "SSH_PROPOSAL_UNAVAILABLE",
  sshProposalInvalid: "SSH_PROPOSAL_INVALID",
  sshProposalExists: "SSH_PROPOSAL_EXISTS",
  sshProposalScanFailed: "SSH_PROPOSAL_SCAN_FAILED",
  sshProposalProject: "SSH_PROPOSAL_PROJECT",
  shareNotFound: "SHARE_NOT_FOUND",
  shareOutside: "SHARE_OUTSIDE",
  shareTooLarge: "SHARE_TOO_LARGE",
  shareEmpty: "SHARE_EMPTY",
  browserUploadNoBrowser: "BROWSER_NOT_GRANTED",
  browserUploadTooLarge: "UPLOAD_TOO_LARGE",
  browserUploadSpace: "UPLOAD_NO_SPACE",
  browserUploadSlow: "UPLOAD_TIMEOUT",
  attachmentStorageFull: "STORAGE_FULL",
  attachmentStorageUnsafe: "STORAGE_UNSAFE",
  goalOwnerOnly: "GOAL_OWNER_ONLY",
  goalUnavailable: "GOAL_UNAVAILABLE",
  goalNotOpen: "GOAL_NOT_OPEN",
  sessionsNotEnabled: "SESSIONS_NOT_ENABLED",
  grantRevoked: "GRANT_REVOKED",
  sessionLimit: "SESSION_LIMIT",
  projectNameInvalid: "PROJECT_NAME_INVALID",
  projectExists: "PROJECT_EXISTS",
  projectNotCreatedByYou: "PROJECT_NOT_CREATED_BY_YOU",
  projectNotEligible: "PROJECT_NOT_ELIGIBLE",
  projectFolderUnavailable: "PROJECT_FOLDER_UNAVAILABLE",
  promptAnswered: "PROMPT_ANSWERED",
  sessionRunning: "SESSION_RUNNING",
  worktreeDirty: "WORKTREE_DIRTY",
  worktreeNotMerged: "WORKTREE_NOT_MERGED",
  noRepository: "NO_REPOSITORY",
  mailNotGranted: "MAIL_NOT_GRANTED",
  mailSendNotGranted: "MAIL_SEND_NOT_GRANTED",
  mailOriginRefused: "MAIL_ORIGIN_REFUSED",
  mailAccountUnavailable: "MAIL_ACCOUNT_UNAVAILABLE",
  mailAuthFailed: "MAIL_AUTH_FAILED",
  mailTlsFailed: "MAIL_TLS_FAILED",
  // An account without its plaintext consent is refused before connecting.
  mailPlaintextRefused: "MAIL_TLS_FAILED",
  mailUnreachable: "MAIL_UNREACHABLE",
  mailTimeout: "MAIL_TIMEOUT",
  mailProtocol: "MAIL_PROTOCOL",
  mailNotFound: "MAIL_NOT_FOUND",
  mailNoTrash: "MAIL_NO_TRASH",
  mailNoArchive: "MAIL_NO_ARCHIVE",
  mailNoDrafts: "MAIL_NO_DRAFTS",
  mailApprovalLimit: "MAIL_APPROVAL_LIMIT",
  mailSendLimit: "MAIL_SEND_LIMIT",
  mailRevoked: "MAIL_REVOKED",
  mailQueryEmpty: "MAIL_QUERY_EMPTY",
  mailSearchUnsupported: "MAIL_SEARCH_UNSUPPORTED",
  mailMoveUnsupported: "MAIL_MOVE_UNSUPPORTED",
  mailDraftUnsupported: "MAIL_DRAFT_UNSUPPORTED",
  mailAttachmentTooLarge: "MAIL_ATTACHMENT_TOO_LARGE",
  mailDraftChanged: "MAIL_DRAFT_CHANGED",
  mailTextUnsupported: "MAIL_TEXT_UNSUPPORTED",
  mailTextFailed: "MAIL_TEXT_FAILED",
  mailBusy: "MAIL_BUSY",
  mailSourceRefused: "MAIL_SOURCE_REFUSED",
  mailSourceNotFound: "MAIL_SOURCE_NOT_FOUND",
  mailSourceEmpty: "MAIL_SOURCE_EMPTY",
  mailSaveRefused: "MAIL_SAVE_REFUSED",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  active: "BUSY",
  provider: "MODEL_UNAVAILABLE",
  unavailable: "UNAVAILABLE",
  turnUnconfirmed: "TURN_UNCONFIRMED",
};
const byStatus = {
  400: "INVALID_INPUT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};
/** The fixed English reason for a code, or the generic one. */
export const toolReason = (code) => reasons[code] ?? reasons.UNAVAILABLE;
// SFTP problems (sftp-errors.js) carry their stable code instead of a message key.
const sftpCode = (error) =>
  !error?.key && /^SFTP_[A-Z_]+$/.test(error?.code ?? "") && reasons[error.code]
    ? error.code
    : null;
// Who answered a coding session's prompt first (coding-sessions/session-requests.js).
const answerers = ["owner", "agent", "telegram", "session"];
export function toolError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code =
    (error?.key === "invalid" && status === 403 ? "FORBIDDEN" : byKey[error?.key]) ||
    sftpCode(error) ||
    byStatus[status] ||
    (status === 413 ? "REQUEST_TOO_LARGE" : "UNAVAILABLE");
  return {
    status: status >= 400 && status < 600 ? status : 503,
    code,
    reason:
      code === "PROMPT_ANSWERED" && answerers.includes(error.answeredBy)
        ? `${reasons[code]} Answered by: ${error.answeredBy}.`
        : reasons[code],
  };
}
