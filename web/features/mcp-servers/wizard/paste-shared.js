// Shared by the wizard state and the paste parser; imports nothing, so neither
// depends on the other.
export const pasteLimit = 64 * 1024;

/** SSE when the address path ends in /sse, else HTTP. */
export function guessTransport(url) {
  try {
    return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "http";
  } catch {
    return "http";
  }
}
