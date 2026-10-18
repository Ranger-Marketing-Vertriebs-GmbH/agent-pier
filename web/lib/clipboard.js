/**
 * Writes text to the clipboard; resolves true on success and false where the
 * Clipboard API is missing (plain HTTP) or refuses the write (iOS outside a gesture).
 */
export async function writeClipboard(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
