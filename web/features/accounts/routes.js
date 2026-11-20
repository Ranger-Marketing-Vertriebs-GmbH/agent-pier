// Accounts subpages: /accounts?section=<group>&item=<id|new>[&step=<wizard step>]
// A provider connection link may name one model row: `&model=<model id>`.
import { validModelId } from "../provider-connections/endpoint-draft.js";

export const accountSections = ["models", "services", "mcp-servers", "cli"];
// Provider connection, ChatGPT (openclaw:<hash>), MCP server and CLI account ids.
export const accountItemPattern = /^(?:new|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
// The MCP server wizard's steps (wizard-state.js); a saved server opens its edit steps.
// "directory" and "paste" are reserved for the directory and paste plans: until their
// screens exist, McpWizard sends such links back to the source step.
export const newWizardSteps = [
  "source",
  "directory",
  "package",
  "remote",
  "command",
  "paste",
  "settings",
  "install",
  "review",
  "connect",
  "done",
];
export const editWizardSteps = ["setup", "settings", "connect"];
const reservedItems = ["new", "cli-finds"];

function wizardStep(section, item, step) {
  if (section !== "mcp-servers" || !item || typeof step !== "string") return "";
  if (item === "new") return newWizardSteps.includes(step) ? step : "";
  if (reservedItems.includes(item)) return "";
  return editWizardSteps.includes(step) ? step : "";
}

// The model row a provider connection link opens (its context field gets the focus).
function modelRow(section, item, model) {
  if (section !== "models" || !item || reservedItems.includes(item)) return "";
  return typeof model === "string" && validModelId(model) ? model : "";
}

export function readAccountsQuery(search) {
  const query = new URLSearchParams(search);
  const section = query.get("section");
  if (!accountSections.includes(section)) return {};
  const raw = query.get("item") || "";
  const item = accountItemPattern.test(raw) ? raw : "";
  const step = wizardStep(section, item, query.get("step"));
  const model = modelRow(section, item, query.get("model"));
  return {
    section,
    ...(item ? { item } : {}),
    ...(step ? { step } : {}),
    ...(model ? { model } : {}),
  };
}

export function accountsQuery(route) {
  if (!accountSections.includes(route.section)) return "";
  const query = new URLSearchParams({ section: route.section });
  const item = route.item && accountItemPattern.test(route.item) ? route.item : "";
  if (item) query.set("item", item);
  const step = wizardStep(route.section, item, route.step);
  if (step) query.set("step", step);
  const model = modelRow(route.section, item, route.model);
  if (model) query.set("model", model);
  return `?${query}`;
}
