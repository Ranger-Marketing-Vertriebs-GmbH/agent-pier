import { accounts } from "./en/accounts.js";
import { agentbus } from "./en/agentbus.js";
import { artifacts } from "./en/artifacts.js";
import { chat, chatAttachmentCopy } from "./en/chat.js";
import { chatDeliveryCopy } from "./en/chat-delivery.js";
import { common } from "./en/common.js";
import { extensions } from "./en/extensions.js";
import { filesCopy } from "./en/files.js";
import { http } from "./en/http.js";
import { loginMessages } from "./en/login.js";
import { models } from "./en/models.js";
import { plugins } from "./en/plugins.js";
import { releaseCopy } from "./en/releases.js";
import { repositories } from "./en/repositories.js";
import { requestCopy } from "./en/requests.js";
import { sessions } from "./en/sessions.js";
import { settings } from "./en/settings.js";
import { ssh } from "./en/ssh.js";
import { tools } from "./en/tools.js";
import { sessionInput } from "./en/session-input.js";
import { sessionReload } from "./en/session-reload.js";
import { sessionTransfer } from "./en/session-transfer.js";
import { cliProfiles } from "./en/cli-profiles.js";
import { pipelines } from "./en/pipelines.js";
import { pipelineProfiles } from "./en/pipeline-profiles.js";
import { pipelineGraph } from "./en/pipeline-graph.js";
import { pipelineWorkspaces } from "./en/pipeline-workspaces.js";
import { agency } from "./en/agency.js";
import { operations } from "./en/operations.js";
import { backups } from "./en/backups.js";
import { mcp } from "./en/mcp.js";
import { memory } from "./en/memory.js";
import { providers } from "./en/providers.js";
import { notifications } from "./en/notifications.js";
import { audit } from "./en/audit.js";

// English counterpart of catalog-de.js with identical keys.
export const englishServerMessages = Object.freeze({
  sessionInput,
  sessionReload,
  sessionTransfer,
  cliProfiles,
  pipelines,
  pipelineProfiles,
  pipelineGraph,
  pipelineWorkspaces,
  agency,
  operations,
  backups,
  mcp,
  memory,
  providers,
  notifications,
  audit,
  accounts,
  agentbus,
  artifacts,
  chat,
  common,
  extensions,
  http,
  models,
  plugins,
  repositories,
  sessions,
  settings,
  ssh,
  tools,
  requests: requestCopy,
  chatAttachments: chatAttachmentCopy,
  chatDelivery: chatDeliveryCopy,
  files: filesCopy,
  login: loginMessages,
  releases: releaseCopy,
});
