import { readFileSync } from "node:fs";
import { fileProblem } from "./file-errors.js";

const decomposition = new Map(),
  classes = new Map();
const data = readFileSync(
  new URL("./unicode-15.1/UnicodeData.txt", import.meta.url),
  "utf8",
);
for (const line of data.split("\n")) {
  const fields = line.split(";"),
    point = Number.parseInt(fields[0], 16);
  if (Number(fields[3])) classes.set(point, Number(fields[3]));
  if (fields[5] && !fields[5].startsWith("<"))
    decomposition.set(
      point,
      fields[5].split(" ").map((value) => Number.parseInt(value, 16)),
    );
}

function decompose(point) {
  const syllable = point - 0xac00;
  if (syllable < 0 || syllable >= 11172) return decomposition.get(point);
  const trailing = syllable % 28;
  return [
    0x1100 + Math.floor(syllable / 588),
    0x1161 + Math.floor((syllable % 588) / 28),
    ...(trailing ? [0x11a7 + trailing] : []),
  ];
}

/** Unicode 15.1 canonical decomposition/order, independent of the runtime's ICU. */
export function uploadNfd(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length > 16384)
    throw fileProblem("FILE_INVALID_NAME", 400);
  const pending = Array.from(value, (point) => point.codePointAt(0)).reverse();
  const output = [],
    marks = [];
  const flush = () => {
    marks.sort((left, right) => classes.get(left) - classes.get(right));
    output.push(...marks);
    marks.length = 0;
  };
  let work = 0;
  while (pending.length) {
    if (++work > 131072) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    const point = pending.pop(),
      parts = decompose(point);
    if (parts) {
      for (let index = parts.length - 1; index >= 0; index--) pending.push(parts[index]);
    } else if (classes.has(point)) marks.push(point);
    else {
      flush();
      output.push(point);
    }
    if (output.length + marks.length > 65536)
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  }
  flush();
  return output.map((point) => String.fromCodePoint(point)).join("");
}
