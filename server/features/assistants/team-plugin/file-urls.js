import { fileURLToPath } from "node:url";
// OpenClaw's file tools decode a file: input with fileURLToPath (%2E is "."), so a
// guard judges both spellings: the value as written and, when it decodes, its path.
export function fileSpellings(value) {
  const forms = [value];
  if (/^\s*file:/i.test(value))
    try {
      forms.push(fileURLToPath(value.trim()));
    } catch {
      // An undecodable file: value is judged as written.
    }
  return forms;
}
