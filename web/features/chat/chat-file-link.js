// Convert only local file references. The existing file API remains responsible
// for realpath/symlink checks and rejecting access outside the session project.
export function projectLinkPath(href, cwd) {
  if (typeof href !== "string" || !href || href.startsWith("#") || href.startsWith("//"))
    return null;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      value = url.pathname;
    } catch {
      return null;
    }
  } else {
    value = value.split(/[?#]/, 1)[0].replace(/:\d+(?::\d+)?$/, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  const root = typeof cwd === "string" ? cwd.replace(/\/+$/, "") : "";
  if (root && value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  return value.replace(/^(\.\/)+/, "");
}
