const LINE_END = /\r\n|\n|\r(?=[\s\S])/g;

/**
 * Incremental Server-Sent-Events parser following the WHATWG rules: CRLF, LF and lone CR end
 * a line, comments and `retry:` are ignored, events are dispatched on a blank line and
 * `end()` flushes a trailing event. Blocks without a `data:` line are dropped.
 *
 * `maxEventBytes` caps one event's `data`, `event`, `id` and `retry` lines plus any pending
 * partial line. Despite the name it counts UTF-16 code units (JavaScript string length), not
 * encoded bytes; one code unit is at most three UTF-8 bytes. Each pushed chunk is scanned
 * once: a long partial line is not rescanned on later pushes. A caller-supplied `stats`
 * object (test hook) accumulates `scannedChars`, the characters handed to the line scanner.
 */
export function createSseParser({ maxEventBytes = 16 * 1024 * 1024, stats } = {}) {
  let buffer = "";
  let scanFrom = 0;
  let started = false;
  let eventName;
  let eventId;
  let dataLines = [];
  let hasData = false;
  let eventSize = 0;

  const reset = () => {
    eventName = undefined;
    eventId = undefined;
    dataLines = [];
    hasData = false;
    eventSize = 0;
  };

  const grow = (size) => {
    if (eventSize + size > maxEventBytes) throw new RangeError("sseEventTooLarge");
    eventSize += size;
  };

  const dispatch = (events) => {
    if (hasData) {
      events.push({ event: eventName, data: dataLines.join("\n"), id: eventId });
    }
    reset();
  };

  const processLine = (line, events) => {
    if (line === "") return dispatch(events);
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      grow(value.length + 1);
      dataLines.push(value);
      hasData = true;
    } else if (field === "event") {
      grow(value.length);
      eventName = value;
    } else if (field === "id") {
      grow(value.length);
      if (!value.includes("\0")) eventId = value;
    } else if (field === "retry") {
      grow(value.length);
    }
  };

  const drain = (final) => {
    const events = [];
    let start = 0;
    if (stats) stats.scannedChars = (stats.scannedChars ?? 0) + buffer.length - scanFrom;
    LINE_END.lastIndex = scanFrom;
    let match;
    while ((match = LINE_END.exec(buffer))) {
      processLine(buffer.slice(start, match.index), events);
      start = match.index + match[0].length;
    }
    buffer = buffer.slice(start);
    // A trailing CR may still be followed by LF; resume the scan there, else after the buffer.
    scanFrom = buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
    if (final) {
      if (buffer !== "") processLine(buffer.replace(/\r$/, ""), events);
      buffer = "";
      scanFrom = 0;
      dispatch(events);
    } else if (eventSize + buffer.length > maxEventBytes) {
      throw new RangeError("sseEventTooLarge");
    }
    return events;
  };

  return {
    push(text) {
      if (!started && text !== "") {
        started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      buffer += text;
      return drain(false);
    },
    end() {
      return drain(true);
    },
  };
}

const encodeData = (data) => {
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError("sseDataNotSerializable");
  return json;
};

/**
 * `data:` frame; the payload is JSON-encoded unless it is the `[DONE]` sentinel.
 * Throws a TypeError for payloads JSON cannot encode (`undefined`, functions).
 */
export function sseData(data) {
  return `data: ${data === "[DONE]" ? data : encodeData(data)}\n\n`;
}

/** Named event frame with a JSON data payload; the name must be a non-empty single line. */
export function sseEvent(name, data) {
  if (typeof name !== "string" || name === "" || /[\r\n]/.test(name)) {
    throw new TypeError("sseEventNameInvalid");
  }
  return `event: ${name}\ndata: ${encodeData(data)}\n\n`;
}

/** Comment frame (keep-alive); line breaks in the text become separate comment lines. */
export function sseComment(text) {
  return `${String(text)
    .split(/\r\n|\n|\r/)
    .map((line) => `: ${line}\n`)
    .join("")}\n`;
}
