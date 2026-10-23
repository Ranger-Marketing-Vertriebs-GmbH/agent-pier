// A synthetic Claude thinking-block signature of the given kind ("thinking" or
// "narration"), shaped like the real ones: field 2 > field 1 > string field 8.
const delimited = (number, payload) => {
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([(number << 3) | 2, body.length]), body]);
};

export function claudeSignature(kind) {
  const inner = Buffer.concat([Buffer.from([0x08, 0x13]), delimited(8, kind)]);
  const outer = delimited(1, inner);
  return Buffer.concat([
    Buffer.from([0x08, 0x04]),
    delimited(2, outer),
    delimited(3, "synthetic payload"),
  ]).toString("base64");
}
