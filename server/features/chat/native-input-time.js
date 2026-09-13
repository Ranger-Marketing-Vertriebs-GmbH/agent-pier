/** Codex user-item UUIDv7 timestamps identify creation, unlike history read time. */
export function codexInputTime(id) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    return undefined;
  const milliseconds = Number.parseInt(id.slice(0, 13).replace("-", ""), 16);
  return milliseconds > 0 && milliseconds <= 8640000000000000 ? milliseconds : undefined;
}
