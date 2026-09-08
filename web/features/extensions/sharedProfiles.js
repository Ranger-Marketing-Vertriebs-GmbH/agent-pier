import { names } from "../../lib/providers.js";
export function extensionProfiles(accounts, shared) {
  if (!shared) return accounts.filter((account) => account.tool !== "shell");
  return ["codex", "claude", "opencode"]
    .filter((tool) => accounts.some((account) => account.tool === tool))
    .map((tool) => ({
      id: `local-${tool}`,
      tool,
      name: names[tool],
      kind: "local",
      shared: true,
    }));
}
