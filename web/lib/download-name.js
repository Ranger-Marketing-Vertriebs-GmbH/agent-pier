/** The file name a download response names (RFC 5987 first), or `fallback`. */
export function downloadName(header, fallback = "download") {
  const value = String(header || "");
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded)
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // A malformed name falls back to the plain one.
    }
  const plain = /filename="([^"]*)"/i.exec(value);
  return plain?.[1] || fallback;
}
