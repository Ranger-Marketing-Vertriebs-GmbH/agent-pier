/** Reject an unusable delta before publishing any part of it. */
export function applyChatSync(previous, response) {
  if (!response.sync || response.sync.mode === "full") return response;
  const { sync, metadata, upserts, removed } = response;
  const invalid = () => {
    throw new Error("Invalid chat delta");
  };
  if (
    sync.mode !== "delta" ||
    !previous?.sync?.cursor ||
    sync.base !== previous.sync.cursor ||
    typeof sync.cursor !== "string" ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    "messages" in metadata ||
    "sync" in metadata ||
    metadata.providerSessionId !== previous.providerSessionId ||
    !Array.isArray(upserts) ||
    !Array.isArray(removed) ||
    !Array.isArray(previous.messages)
  )
    invalid();
  const rows = new Map(previous.messages.map((row) => [row.id, row]));
  if (rows.size !== previous.messages.length || new Set(removed).size !== removed.length)
    invalid();
  for (const key of removed) if (!rows.delete(key)) invalid();
  const changed = new Set();
  for (const row of upserts) {
    if (
      !row ||
      typeof row.id !== "string" ||
      changed.has(row.id) ||
      removed.includes(row.id)
    )
      invalid();
    changed.add(row.id);
    rows.set(row.id, row);
  }
  const order =
    response.order === undefined
      ? previous.messages.map((row) => row.id)
      : response.order;
  if (
    !Array.isArray(order) ||
    new Set(order).size !== order.length ||
    order.length !== rows.size ||
    order.some((key) => !rows.has(key))
  )
    invalid();
  return {
    ...metadata,
    messages: order.map((key) => rows.get(key)),
    sync: { mode: "full", cursor: sync.cursor },
  };
}

/** Keep rows pushed out of a rolling live window, while honoring actual deletions. */
export function chatWindowPrefix(previous, next) {
  if (!next.history?.cursor || !previous?.messages?.length || !next.messages.length)
    return [];
  const start = previous.messages.findIndex((row) => row.id === next.messages[0].id);
  const oldTail = next.messages.findIndex(
    (row) => row.id === previous.messages.at(-1).id,
  );
  // A shared tail followed by new rows proves that the window advanced. A
  // deletion alone (including a removed first row) must not resurrect that row.
  // Disjoint windows cannot distinguish a large append burst from replacement
  // without source offsets; the hook resets pagination to the newest cursor then.
  return start > 0 && oldTail >= 0 && oldTail < next.messages.length - 1
    ? previous.messages.slice(0, start)
    : [];
}
