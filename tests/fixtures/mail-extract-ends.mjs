// A mail text extractor that ends the way its document names: `%PDF-signal:<NAME>`
// sends itself that signal, `%PDF-exit:<code>` exits without an answer, and
// `%PDF-reply:<json>` sends that reply and exits 1, as the real child does on failure.
process.once("message", ({ bytes }) => {
  const [, how, value] = /^%PDF-(\w+):(.*)$/s.exec(Buffer.from(bytes).toString("utf8"));
  if (how === "signal") process.kill(process.pid, value);
  else if (how === "exit") process.exit(Number(value));
  else process.send(JSON.parse(value), () => process.exit(1));
  setInterval(() => {}, 1000);
});
