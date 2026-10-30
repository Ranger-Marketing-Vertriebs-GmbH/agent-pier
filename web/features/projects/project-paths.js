// Repositories, project knowledge and AgentBus each keep their own project ids.
// The hub joins them by folder so one project stands for all three; project groups
// key their assignments by the same normalised path.
export function normalizePath(value) {
  const path = String(value || "");
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || (path.startsWith("/") ? "/" : "");
}
