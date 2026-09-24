export function hostOrigin(value) {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim().toLowerCase();
  }
}
export function hostHasPort(value) {
  try {
    return Boolean(new URL(value).port);
  } catch {
    return false;
  }
}
export function hostLabel(value) {
  return String(value || "").replace(/^https?:\/\//, "");
}
