import { accounts } from "./de/accounts.js";
import { agentbus } from "./de/agentbus.js";
import { artifacts } from "./de/artifacts.js";
import { chat, chatAttachmentCopy } from "./de/chat.js";
import { chatDeliveryCopy } from "./de/chat-delivery.js";
import { common } from "./de/common.js";
import { extensions } from "./de/extensions.js";
import { filesCopy } from "./de/files.js";
import { http } from "./de/http.js";
import { loginMessages } from "./de/login.js";
import { models } from "./de/models.js";
import { plugins } from "./de/plugins.js";
import { releaseCopy } from "./de/releases.js";
import { repositories } from "./de/repositories.js";
import { requestCopy } from "./de/requests.js";
import { sessions } from "./de/sessions.js";
import { settings } from "./de/settings.js";
import { ssh } from "./de/ssh.js";
import { tools } from "./de/tools.js";
import { sessionInput } from "./de/session-input.js";
import { sessionReload } from "./de/session-reload.js";
import { sessionTransfer } from "./de/session-transfer.js";
import { cliProfiles } from "./de/cli-profiles.js";
import { pipelines } from "./de/pipelines.js";
import { pipelineProfiles } from "./de/pipeline-profiles.js";
import { pipelineGraph } from "./de/pipeline-graph.js";
import { pipelineWorkspaces } from "./de/pipeline-workspaces.js";
import { agency } from "./de/agency.js";
import { operations } from "./de/operations.js";
import { backups } from "./de/backups.js";
import { mcp } from "./de/mcp.js";
import { memory } from "./de/memory.js";
import { providers } from "./de/providers.js";
import { notifications } from "./de/notifications.js";
import { audit } from "./de/audit.js";

// Browser-visible German server messages; top-level names are the stable key prefix.
// Operator script output (de/scripts.js) is terminal-only and stays out on purpose.
export const germanServerMessages = Object.freeze({
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
