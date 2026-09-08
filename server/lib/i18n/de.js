import { scripts } from "./de/scripts.js";
import { sessions } from "./de/sessions.js";
import { common } from "./de/common.js";
import { http } from "./de/http.js";
import { accounts } from "./de/accounts.js";
import { agentbus } from "./de/agentbus.js";
import { extensions } from "./de/extensions.js";
import { models } from "./de/models.js";
import { repositories } from "./de/repositories.js";
import { plugins } from "./de/plugins.js";
import { chat } from "./de/chat.js";
import { tools } from "./de/tools.js";
import { settings } from "./de/settings.js";

/** German product locale shared by backend routes and operational scripts. */
export const serverMessages = Object.freeze({
  scripts,
  sessions,
  common,
  http,
  accounts,
  agentbus,
  extensions,
  models,
  repositories,
  plugins,
  chat,
  tools,
  settings,
});
