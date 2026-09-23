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

// English counterpart of catalog-de.js with identical keys.
export const englishServerMessages = Object.freeze({
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
