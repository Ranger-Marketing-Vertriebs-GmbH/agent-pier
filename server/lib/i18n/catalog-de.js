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

// Browser-visible German server messages; top-level names are the stable key prefix.
// Operator script output (de/scripts.js) is terminal-only and stays out on purpose.
export const germanServerMessages = Object.freeze({
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
