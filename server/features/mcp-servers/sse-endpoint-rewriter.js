import { Transform } from "node:stream";

// Rewrites the `endpoint` event of the legacy HTTP+SSE transport (the server's
// message URL, relative or absolute) to the proxy's message route
// `/mcp/<serverId>/message?target=<path>`; every other event passes byte for byte,
// each as soon as it is complete. A URL off the server's origin, or a value that is
// no URL, becomes `about:blank`: the runtime never posts to an address the server
// chose.
//
// The stream is handled as bytes (a latin1 string holds one character per byte), so a
// character or a line end split across two chunks stays as the server sent it. Lines
// end as the event stream format says: CRLF, LF or a lone CR.
//
// Only an incomplete event block is held, and at most `BLOCK_LIMIT` bytes of it. An
// endpoint event is a few hundred bytes; the other events of the transport carry
// JSON-RPC messages of any size. A block that grows past the limit therefore passes
// through as it arrives (a tool result of several megabytes stays intact), and it must
// not be an endpoint event: one that large ends the stream with an error, since its
// first bytes may already be with the runtime and can no longer be rewritten.

/** The most bytes of one incomplete event block the rewriter holds: 64 KiB. */
export const BLOCK_LIMIT = 64 * 1024;
// Bytes already sent that are kept to recognise an event line split across chunks.
const LOOKBEHIND = 256;

const LINE_END = "(?:\\r\\n|\\r(?!\\n)|\\n)";
const BLOCK_END = new RegExp(LINE_END + LINE_END);
const LINE = /\r\n|\r|\n/;
const ENDPOINT_LINE = /^event:\s*endpoint\s*$/;
const ENDPOINT_IN_PASSING = /[\r\n]event:[ \t]*endpoint/;

export function endpointRewriter(server, serverId) {
  const origin = new URL(server.url).origin;
  const route = `/mcp/${encodeURIComponent(serverId)}/message?target=`;
  // The incomplete block; while a block passes through, only a line end at the end of
  // what arrived, which may be the first half of the blank line that ends the block.
  let held = "";
  let passing = false;
  let sent = "\n";

  const proxied = (value) => {
    let upstream;
    try {
      upstream = new URL(value, server.url);
    } catch {
      return "about:blank";
    }
    if (upstream.origin !== origin) return "about:blank";
    return route + Buffer.from(upstream.pathname + upstream.search).toString("base64url");
  };
  const rewrite = (block) => {
    const lines = block.split(LINE);
    if (!lines.some((line) => ENDPOINT_LINE.test(line))) return block;
    return lines
      .map((line) => {
        const data = /^data:\s?(.*)$/.exec(line);
        if (!data) return line;
        return `data: ${proxied(Buffer.from(data[1], "latin1").toString("utf8").trim())}`;
      })
      .join("\n");
  };
  const step = (chunk) => {
    let text = held + chunk;
    let out = "";
    for (;;) {
      const end = BLOCK_END.exec(text);
      if (passing) {
        const part = end
          ? text.slice(0, end.index + end[0].length)
          : text.replace(/(?:\r\n|\r|\n)$/, "");
        if (ENDPOINT_IN_PASSING.test(sent + part))
          throw new Error("The MCP server sent an endpoint event that is too large.");
        out += part;
        text = text.slice(part.length);
        sent = end ? "\n" : (sent + part).slice(-LOOKBEHIND);
        passing = !end;
        if (passing) break;
      } else if (end) {
        out += rewrite(text.slice(0, end.index)) + end[0];
        text = text.slice(end.index + end[0].length);
      } else if (text.length > BLOCK_LIMIT) {
        passing = true;
      } else break;
    }
    held = text;
    return out;
  };
  const bytes = (text) => (text ? Buffer.from(text, "latin1") : undefined);

  return new Transform({
    transform(chunk, _encoding, done) {
      let out;
      try {
        out = step(chunk.toString("latin1"));
      } catch (error) {
        return done(error);
      }
      done(null, bytes(out));
    },
    flush(done) {
      done(null, bytes(passing ? held : rewrite(held)));
    },
  });
}
