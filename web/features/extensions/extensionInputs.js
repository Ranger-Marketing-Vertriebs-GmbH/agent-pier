import { extensionInputsCopy as copy } from "../../lib/i18n/messages/extensions.js";
export const MAX_FILE = 10 * 1024 * 1024;
export function fileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(copy.fileReadFailed));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
