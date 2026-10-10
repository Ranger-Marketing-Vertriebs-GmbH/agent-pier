export async function sendTelegramParts({
  client,
  entry,
  save,
  signal,
  changed = () => {},
}) {
  if (entry.state !== "outbound" || entry.nextDeliveryAt > Date.now()) return;
  for (let index = 0; index < entry.parts.length; index++) {
    if (signal.aborted) return;
    if (entry.parts[index].state === "sent") continue;
    const parts = entry.parts.map((part, n) =>
      n === index ? { ...part, state: "sending" } : part,
    );
    entry = save({ parts, state: "delivering" });
    const send = (part) =>
      client.call(
        "sendMessage",
        {
          chat_id: entry.chatId,
          // Parts stored before formatting existed carry plain text only.
          ...(part.html ? { text: part.html, parse_mode: "HTML" } : { text: part.text }),
          link_preview_options: { is_disabled: true },
          ...(index === entry.parts.length - 1 && entry.actions?.length
            ? {
                reply_markup: {
                  inline_keyboard: [
                    entry.actions.map((action) => ({
                      text: action.label,
                      callback_data: action.handle,
                    })),
                  ],
                },
              }
            : {}),
        },
        signal,
      );
    try {
      let result;
      try {
        result = await send(parts[index]);
      } catch (error) {
        if (!error.badRequest || !parts[index].html) throw error;
        // Telegram refused the request outright (for example unparsable markup
        // or a link target it does not accept), so nothing was delivered.
        // The same durable part goes out once more as plain text; recording the
        // switch first keeps a restart from ever retrying the markup.
        parts[index] = { ...parts[index], html: null };
        entry = save({ parts, state: "delivering" });
        result = await send(parts[index]);
      }
      if (
        !Number.isSafeInteger(result?.message_id) ||
        String(result.chat?.id) !== entry.chatId
      )
        throw Error("Unconfirmed destination");
      parts[index] = { ...parts[index], state: "sent", messageId: result.message_id };
      entry = save({
        parts,
        state: "outbound",
        remoteMessageIds: parts.filter((p) => p.state === "sent").map((p) => p.messageId),
        diagnostic: null,
      });
    } catch (error) {
      if (error.code === "TELEGRAM_RATE_LIMIT") {
        parts[index] = { ...parts[index], state: "pending" };
        save({
          parts,
          state: "outbound",
          diagnostic: "TELEGRAM_RATE_LIMIT",
          nextDeliveryAt:
            Date.now() + Math.max(1, Math.min(error.retryAfter || 30, 3600)) * 1000,
        });
      } else if (error.rejected) {
        parts[index] = { ...parts[index], state: "pending" };
        save({
          parts,
          state: "delivery_failed",
          diagnostic: "TELEGRAM_REJECTED",
        });
      } else
        save({
          state: "delivery_uncertain",
          diagnostic: "DELIVERY_UNCERTAIN",
        });
      changed();
      return;
    }
  }
  save({ state: "delivered", diagnostic: null });
  changed();
}
