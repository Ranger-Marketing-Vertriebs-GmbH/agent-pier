// The image viewer's zoom and pan as plain geometry. A view is the image's scale and its
// offset from the stage's centre (the image is centred at rest and scales around its own
// centre); points are relative to the stage's centre as well.
export const maxScale = 4;

const between = (value, limit) => Math.min(limit, Math.max(-limit, value)) + 0;

/**
 * The view within bounds: scaled 1–4×, and never moved further than its zoomed edges
 * reach, so no part of the stage shows a gap beside an image larger than it. An image
 * no larger than the stage along an axis stays centred along it.
 */
export function clampView(view, image, stage) {
  const scale = Math.min(maxScale, Math.max(1, view.scale));
  const reach = (length, room) => Math.max(0, (length * scale - room) / 2);
  return {
    scale,
    x: between(view.x, reach(image.width, stage.width)),
    y: between(view.y, reach(image.height, stage.height)),
  };
}

/**
 * A pinch: `start` scaled by `factor`, with the image point that was under `from` (the
 * fingers' first midpoint) moved under `to` (their midpoint now). Unclamped offsets.
 */
export function pinchView(start, from, to, factor) {
  const scale = Math.min(maxScale, Math.max(1, start.scale * factor));
  const ratio = scale / start.scale;
  return {
    scale,
    x: to.x - ratio * (from.x - start.x),
    y: to.y - ratio * (from.y - start.y),
  };
}

/** `view` at `scale`, keeping the image point under `point` where it is. */
export const zoomAt = (view, scale, point) =>
  pinchView(view, point, point, scale / view.scale);

// Wheel deltas come in pixels, lines or pages (WheelEvent.deltaMode 0, 1, 2).
const lineHeight = 16;

/**
 * `view` moved by a wheel or trackpad scroll as a page would scroll: down shows more of
 * the image's bottom, and shift turns a vertical wheel sideways. Unclamped offsets.
 */
export function scrollView(view, { deltaX, deltaY, deltaMode = 0, shiftKey }, stage) {
  const unit = [1, lineHeight, stage.height][deltaMode] ?? 1;
  const sideways = shiftKey && !deltaX;
  const dx = (sideways ? deltaY : deltaX) * unit;
  const dy = (sideways ? 0 : deltaY) * unit;
  return { ...view, x: view.x - dx, y: view.y - dy };
}
