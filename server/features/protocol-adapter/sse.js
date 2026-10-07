const LINE_END = /\r\n|\n|\r(?=[\s\S])/g;

/**
 * Incremental Server-Sent-Events parser following the WHATWG rules: CRLF, LF and lone CR end
 * a line, comments and `retry:` are ignored, events are dispatched on a blank line and
 * `end()` flushes a trailing event. Blocks without a `data:` line are dropped.
 * Sizes are counted in UTF-16 code units.
 */
export function createSseParser({ maxEventBytes = 16 * 1024 * 1024 } = {}) {
  let buffer = "";
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
    } else if (field === "id" && !value.includes("\0")) {
      eventId = value;
    }
  };

  const drain = (final) => {
    const events = [];
    let start = 0;
    LINE_END.lastIndex = 0;
    let match;
    while ((match = LINE_END.exec(buffer))) {
      processLine(buffer.slice(start, match.index), events);
      start = match.index + match[0].length;
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer !== "") processLine(buffer.replace(/\r$/, ""), events);
      buffer = "";
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

/** `data:` frame; the payload is JSON-encoded unless it is the `[DONE]` sentinel. */
export function sseData(data) {
  return `data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`;
}

/** Named event frame with a JSON data payload. */
export function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Comment frame (keep-alive); line breaks in the text become separate comment lines. */
export function sseComment(text) {
  return `${String(text)
    .split(/\r\n|\n|\r/)
    .map((line) => `: ${line}\n`)
    .join("")}\n`;
}
