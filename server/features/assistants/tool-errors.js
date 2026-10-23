// Agent tools return a stable code and a fixed English reason the model can act
// on. Problem texts are owner-facing German UI copy and may name internals, so
// they never reach the model; only real transport or runtime failures read as
// "unavailable".
import { autonomousCaps } from "./team-policy.js";
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
  MEMBER_REMINDER_LIMIT:
    "Your team already set the most reminders a team may set on its lead. Do not retry; report the reminder you wanted to your lead instead.",
  ROUTINE_OWNER_TURN:
    "Routines on members can only be set up or changed in a turn of the owner's own message, not in scheduled, forwarded or member-result turns. Do not retry now; offer it to the owner.",
  ROUTINE_MEMBER_NOT_PERMANENT:
    "Routines can only be set up on your own permanent members; temporary members work only on their task. Ask the owner to keep the member as a permanent agent first.",
  ROUTINE_MEMBER_OFF:
    "This member has routines switched off in its settings. Do not retry; ask the owner to switch them on.",
  ROUTINE_TOO_FREQUENT:
    "A routine on a member may run at most every 15 minutes. Choose a less frequent schedule.",
  ROUTINE_NOT_REQUESTED:
    "At your team usage 'On request' you set up a routine on a member only when the owner's own message in this turn asks for it and names that member. Ask the owner instead of retrying.",
  ROUTINE_MEMBER_LIMIT:
    "You already run the most routines allowed on this member (5). Change or remove one of them with agentpier_team_member_routine instead.",
  MEMBER_NOT_RUNNING:
    "Grants are only for your own task members that are not archived, and shares only for your own permanent members. Check agentpier_team_members for the memberId.",
  FORBIDDEN:
    "This action is not permitted for this agent in the current turn. Do not retry; explain this to the owner.",
  NOT_FOUND:
    "The referenced item does not exist or is not accessible. Use catalog, list or status to find valid IDs.",
  CONFLICT:
    "The item changed or this call conflicts with an earlier one. Read the current state and retry with the current revision.",
  BUSY: "Another operation is still active, for example a running team or a pending request. Check its status instead of retrying.",
  REVIEW_REQUIRED:
    "It is unclear whether this was already created. Ask the owner to check the agent settings before retrying.",
  MODEL_UNAVAILABLE:
    "The model connection of this agent is not available. Ask the owner to choose a model connection.",
  MEMBER_NOT_PERMANENT:
    "Tasks can only be delegated to permanent members. Ask a temporary member a question instead, or ask the owner to keep it as a permanent agent.",
  TASK_OPEN:
    "This member already has an open task. Wait for its result or cancel it with agentpier_team_cancel.",
  MEMBER_NOT_FINISHED:
    "Only your finished temporary members without open questions or tasks can be archived. Check agentpier_team_members.",
  RATE_LIMITED:
    "Too many questions or tasks for your members in this turn or minute. Do not retry now; tell the owner what is still open, or let the owner approve more.",
  AUTONOMOUS_LIMIT: `You already started ${autonomousCaps.perTurn} questions or tasks for your members on your own in this turn, or ${autonomousCaps.perHour} in the last hour. Do not retry; finish with what you have and tell the owner what is still open. The owner can ask you by name for more.`,
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
    "In routines only hosts the owner marked 'Trusted incl. routines' run commands. Do not retry; say in the routine's result that SSH was refused for this host.",
  SSH_ORIGIN_REFUSED:
    "SSH is not available in this turn: it was not the owner's own request (forwarded, scheduled or member content). Do not retry; tell the owner.",
  SSH_BUSY:
    "Another SSH command of yours is still running. Wait for its result before you start the next one.",
  SSH_APPROVAL_LIMIT:
    "Three of your SSH commands already wait for the owner's approval. Wait for decisions before you request more.",
  SSH_REVOKED:
    "The SSH access changed or the turn ended while the command waited or ran; it was stopped. Do not retry without the owner.",
  PROJECT_NOT_GRANTED:
    "This project folder is not granted to you. Your instructions list the project folders you may use; ask the owner (or your lead) for access instead of retrying.",
  PROJECT_READ_ONLY:
    "You may only read this project folder. Do not retry the change; tell the owner (or your lead) what you wanted to change.",
  ROUTINE_WRITES_OWNER_ONLY:
    "'May write' cannot be switched with your routine tool in this chat. Do not retry; ask the owner to switch 'May write' for this routine in the agent settings. The routine still runs and only reads.",
  ROUTINE_READ_ONLY:
    "This routine may only read project folders: the owner has not allowed it to write. Do not retry; say in the routine's result which change you would make, so the owner can switch on 'May write' for this routine or make it.",
  PERMANENT_ACCESS_ONLY:
    "A permanent member's tools and settings are the owner's. You can only share your project folders (grants.projects), coding projects (coding) and MCP servers (mcpServers) with it. Remove the other grants and try again.",
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
  STORAGE_FULL:
    "AgentPier's storage for this file is full. Do not retry; tell the owner.",
  STORAGE_UNSAFE:
    "AgentPier's storage for shared files is not a plain folder, so nothing can be shared. Do not retry; tell the owner.",
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
  memberReminderLimit: "MEMBER_REMINDER_LIMIT",
  leadRoutineOwnerTurn: "ROUTINE_OWNER_TURN",
  leadRoutineNotPermanent: "ROUTINE_MEMBER_NOT_PERMANENT",
  leadRoutineMemberOff: "ROUTINE_MEMBER_OFF",
  leadRoutineInterval: "ROUTINE_TOO_FREQUENT",
  leadRoutineNotRequested: "ROUTINE_NOT_REQUESTED",
  leadRoutineLimit: "ROUTINE_MEMBER_LIMIT",
  memberRequestNotPermanent: "MEMBER_NOT_PERMANENT",
  memberRequestOpenTask: "TASK_OPEN",
  memberRequestNotFinished: "MEMBER_NOT_FINISHED",
  memberRequestUnavailable: "MEMBER_UNAVAILABLE",
  memberRequestRate: "RATE_LIMITED",
  templateNotFound: "TEMPLATE_NOT_FOUND",
  templateBlocked: "TEMPLATE_BLOCKED",
  templateTooLarge: "TEMPLATE_TOO_LARGE",
  templateUnavailable: "TEMPLATE_UNAVAILABLE",
  memberRequestAutonomousLimit: "AUTONOMOUS_LIMIT",
  sshNotGranted: "SSH_NOT_GRANTED",
  sshHostUnavailable: "SSH_HOST_UNAVAILABLE",
  sshRoutineNotTrusted: "SSH_ROUTINE_NOT_TRUSTED",
  sshOriginRefused: "SSH_ORIGIN_REFUSED",
  sshBusy: "SSH_BUSY",
  sshApprovalLimit: "SSH_APPROVAL_LIMIT",
  sshRevoked: "SSH_REVOKED",
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
  shareNotFound: "SHARE_NOT_FOUND",
  shareOutside: "SHARE_OUTSIDE",
  shareTooLarge: "SHARE_TOO_LARGE",
  shareEmpty: "SHARE_EMPTY",
  attachmentStorageFull: "STORAGE_FULL",
  attachmentStorageUnsafe: "STORAGE_UNSAFE",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  active: "BUSY",
  provider: "MODEL_UNAVAILABLE",
  unavailable: "UNAVAILABLE",
};
const byStatus = {
  400: "INVALID_INPUT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};
export function toolError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 503;
  const code =
    (error?.key === "invalid" && status === 403 ? "FORBIDDEN" : byKey[error?.key]) ||
    byStatus[status] ||
    (status === 413 ? "REQUEST_TOO_LARGE" : "UNAVAILABLE");
  return {
    status: status >= 400 && status < 600 ? status : 503,
    code,
    reason: reasons[code],
  };
}
