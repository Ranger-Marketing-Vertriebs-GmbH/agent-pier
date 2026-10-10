import { serverCatalogs } from "../../lib/i18n/catalogs.js";
/**
 * Assistant messages for text AgentPier writes into Telegram. The interface
 * language is a browser preference with no server-side record, so each channel
 * stores the owner's language when it is connected or paired. Resolving per
 * message keeps a language change from touching notices that already exist.
 */
export function telegramMessages(channel) {
  return (serverCatalogs[channel?.language] || serverCatalogs.de).assistants;
}
