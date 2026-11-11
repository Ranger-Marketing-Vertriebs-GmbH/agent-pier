import { endpointRewriter } from "../../server/features/mcp-servers/sse-endpoint-rewriter.js";

export const server = { url: "https://mcp.example/base/sse" };
export const serverId = "srv 1";

/** The proxy's message route for the server path `path` (with its query). */
export const routed = (path) =>
  `/mcp/srv%201/message?target=${Buffer.from(path).toString("base64url")}`;

/** `bytes` cut after each of `sizes` bytes in turn; the rest is the last chunk. */
export function cut(bytes, sizes) {
  const chunks = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= bytes.length) break;
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  if (at < bytes.length) chunks.push(bytes.subarray(at));
  return chunks;
}

/**
 * What the rewriter makes of `chunks` (strings or buffers): `{ bytes, error, most }`
 * with the output, the error that ended it, and the most bytes it held at any time.
 */
export function rewritten(chunks) {
  const stream = endpointRewriter(server, serverId);
  const out = [];
  let written = 0;
  let read = 0;
  let most = 0;
  stream.on("data", (chunk) => {
    out.push(chunk);
    read += chunk.length;
  });
  return new Promise((resolve) => {
    const done = (error = null) => resolve({ bytes: Buffer.concat(out), error, most });
    stream.on("error", done).on("end", () => done());
    (async () => {
      for (const chunk of chunks) {
        if (stream.destroyed) return;
        const bytes = Buffer.from(chunk);
        written += bytes.length;
        await new Promise((next) => stream.write(bytes, () => next()));
        most = Math.max(most, written - read);
      }
      if (!stream.destroyed) stream.end();
    })();
  });
}
