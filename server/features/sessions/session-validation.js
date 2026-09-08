import { problem as failure } from "../../lib/storage.js";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function validId(id) {
  if (typeof id !== "string" || !idPattern.test(id)) throw failure("Invalid session ID");
  return id;
}
export function validName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 160 ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    throw failure("Invalid session name");
  return name.trim();
}
export function dimensions(cols, rows) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 2 ||
    cols > 500 ||
    rows > 300
  )
    throw failure("Invalid terminal dimensions");
}
export function textInput(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 1024 * 1024 ||
    text.includes("\0")
  )
    throw failure("Invalid terminal input");
}
