import { isRelocatableMember } from "./assistant-backup.js";

/**
 * Whether an inspection reads member `name`: application data, databases,
 * artifacts and relocatable agent configuration. Histories, profiles and other
 * agent files are only verified by a restore. Backups write these members first.
 */
export const inspected = (name) =>
  !/^(profiles|sessions|chat|imported-history|sealed)\//.test(name) &&
  (!name.startsWith("assistants/") || isRelocatableMember(name));
