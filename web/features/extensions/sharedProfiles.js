import { names } from "../../lib/providers.js";
import { codingCliIds } from "../../../server/features/clis/catalog.js";
export function extensionProfiles(accounts, shared) {
  if (!shared) return accounts.filter((account) => account.tool !== "shell");
  return codingCliIds()
    .filter((tool) => accounts.some((account) => account.tool === tool))
    .map((tool) => ({
      id: `local-${tool}`,
      tool,
      name: names[tool],
      kind: "local",
      shared: true,
    }));
}
