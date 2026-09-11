import { marketplacesCopy as copy } from "../../lib/i18n/messages/plugins.js";

export function marketplaceLabel(marketplace) {
  return marketplace.builtin && marketplace.name === "openai-curated-remote"
    ? copy.defaultMarketplace
    : marketplace.name;
}
