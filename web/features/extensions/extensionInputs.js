import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionInputsCopy as copy } from "../../lib/i18n/messages/extensions.js";
export const MAX_FILE = 10 * 1024 * 1024;
export function jsonField(value, label, array = false) {
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    throw new Error(copy.invalidJson(label));
  }
  if (
    array
      ? !Array.isArray(data)
      : !data || typeof data !== "object" || Array.isArray(data)
  )
    throw new Error(
      copy.jsonShapeRequired(label, array ? commonCopy.jsonArray : commonCopy.jsonObject),
    );
  return data;
}
export function fileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(copy.fileReadFailed));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
