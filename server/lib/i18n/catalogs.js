import { serverMessages } from "./de.js";
import { requestCopy } from "./de/requests.js";
import { chatAttachmentCopy } from "./de/chat.js";
import { chatDeliveryCopy } from "./de/chat-delivery.js";
import { filesCopy } from "./de/files.js";
import { loginMessages } from "./de/login.js";
import { releaseCopy } from "./de/releases.js";
import { accounts } from "./en/accounts.js";
import { agentbus } from "./en/agentbus.js";
import { artifacts } from "./en/artifacts.js";
import { chat, chatAttachmentCopy as enChatAttachments } from "./en/chat.js";
import { chatDeliveryCopy as enChatDelivery } from "./en/chat-delivery.js";
import { common } from "./en/common.js";
import { extensions } from "./en/extensions.js";
import { filesCopy as enFiles } from "./en/files.js";
import { http } from "./en/http.js";
import { loginMessages as enLogin } from "./en/login.js";
import { models } from "./en/models.js";
import { plugins } from "./en/plugins.js";
import { releaseCopy as enReleases } from "./en/releases.js";
import { repositories } from "./en/repositories.js";
import { requestCopy as enRequests } from "./en/requests.js";
import { sessions } from "./en/sessions.js";
import { settings } from "./en/settings.js";
import { ssh } from "./en/ssh.js";
import { tools } from "./en/tools.js";

// Browser-visible server messages. Operator script output (serverMessages.scripts)
// is terminal-only and intentionally stays out of the browser catalogs.
const { scripts: _operatorOutput, ...browserMessages } = serverMessages;

/** Server message catalogs by language; top-level names form the stable key prefix. */
export const serverCatalogs = Object.freeze({
  de: Object.freeze({
    ...browserMessages,
    requests: requestCopy,
    chatAttachments: chatAttachmentCopy,
    chatDelivery: chatDeliveryCopy,
    files: filesCopy,
    login: loginMessages,
    releases: releaseCopy,
  }),
  en: Object.freeze({
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
    requests: enRequests,
    chatAttachments: enChatAttachments,
    chatDelivery: enChatDelivery,
    files: enFiles,
    login: enLogin,
    releases: enReleases,
  }),
});
