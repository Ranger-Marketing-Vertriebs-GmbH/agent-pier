// Vite emits content-hashed names (`name-XXXXXXXX.ext`); the startup plugin emits
// `startup-<12 hex>.js`. Only these may be frozen; everything else revalidates.
const hashedAsset =
  /^assets\/(?:startup-[a-f0-9]{12}|[^/]+-[A-Za-z0-9_-]{8})\.[a-z0-9]+$/;
export const IMMUTABLE = "max-age=31536000, immutable";
export function cacheControlFor(relativePath) {
  const file = relativePath.split("\\").join("/");
  if (file === "index.html") return "no-store";
  return hashedAsset.test(file) ? IMMUTABLE : "no-cache";
}
