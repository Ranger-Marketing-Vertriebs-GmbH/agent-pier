// A mail text extractor that keeps allocating until its heap limit stops it.
const kept = [];
for (;;) kept.push(new Array(1_000_000).fill(kept.length));
