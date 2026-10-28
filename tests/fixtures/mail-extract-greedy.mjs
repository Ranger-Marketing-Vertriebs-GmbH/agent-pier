// A mail text extractor that keeps allocating until its heap limit stops it.
process.once("message", () => {
  const kept = [];
  for (;;) kept.push(new Array(1_000_000).fill(kept.length));
});
