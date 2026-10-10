// First visible character of a name (a whole code point, so emoji stay intact).
export function avatarGlyph(name) {
  return Array.from(String(name ?? "").trim())[0]?.toLocaleUpperCase() || "◆";
}
