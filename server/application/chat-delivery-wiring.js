import { ChatDelivery } from "../features/chat/chat-delivery.js";
import { DeliveryAcceptance } from "../features/chat/delivery-acceptance.js";

/**
 * Chat delivery with one matcher of native acceptance events: a matching event
 * confirms its delivery (`chatDelivery.acceptance` takes the CLIs' sources).
 */
export function createChatDelivery(options) {
  const acceptance = new DeliveryAcceptance({
    onMatch: (sessionId, deliveryId, outcome) =>
      chatDelivery.accept(sessionId, deliveryId, outcome),
  });
  const chatDelivery = new ChatDelivery({ ...options, acceptance });
  return chatDelivery;
}
