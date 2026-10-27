// The image viewer's zoom and pan as plain geometry. A view is the image's scale and its
// offset from the stage's centre (the image is centred at rest and scales around its own
// centre); points are relative to the stage's centre as well.
export const maxScale = 4;
// An image whose fitted width is under this share of the stage's is a strip (a long
// screenshot): a double tap fills the stage's width with it instead of doubling it.
const strip = 0.5;

const between = (value, limit) => Math.min(limit, Math.max(-limit, value)) + 0;

/** The scale at which the fitted `image` fills the stage's width. */
export const fitWidthScale = (image, stage) =>
  image.width > 0 ? stage.width / image.width : 1;

/**
 * How far `image` may be zoomed: 4×, or twice its fit-to-width scale when that is more,
 * so a long screenshot can be read at the stage's full width and closer still.
 */
export const scaleLimit = (image, stage) =>
  Math.max(maxScale, 2 * fitWidthScale(image, stage));

/**
 * The view within bounds: scaled from 1× to the image's limit, and never moved further
 * than its zoomed edges reach, so no part of the stage shows a gap beside an image
 * larger than it. An image no larger than the stage along an axis stays centred along it.
 */
export function clampView(view, image, stage) {
  const scale = Math.min(scaleLimit(image, stage), Math.max(1, view.scale));
  const reach = (length, room) => Math.max(0, (length * scale - room) / 2);
  return {
    scale,
    x: between(view.x, reach(image.width, stage.width)),
    y: between(view.y, reach(image.height, stage.height)),
  };
}

/**
 * A pinch: `start` scaled by `factor` up to `limit`, with the image point that was under
 * `from` (the fingers' first midpoint) moved under `to` (their midpoint now). Unclamped
 * offsets.
 */
export function pinchView(start, from, to, factor, limit = maxScale) {
  const scale = Math.min(limit, Math.max(1, start.scale * factor));
  const ratio = scale / start.scale;
  return {
    scale,
    x: to.x - ratio * (from.x - start.x),
    y: to.y - ratio * (from.y - start.y),
  };
}

/** `view` at `scale` (up to `limit`), keeping the image point under `point` where it is. */
export const zoomAt = (view, scale, point, limit) =>
  pinchView(view, point, point, scale / view.scale, limit);

/**
 * Where a double tap at `point` leads: back to rest when zoomed; a strip to the stage's
 * full width with its top edge at the stage's top, to read it from the start; any other
 * image to 2× around the tap. Unclamped offsets.
 */
export function doubleTapView(view, point, image, stage) {
  if (view.scale > 1) return { scale: 1, x: 0, y: 0 };
  if (image.width >= stage.width * strip)
    return zoomAt(view, 2, point, scaleLimit(image, stage));
  const scale = fitWidthScale(image, stage);
  return { scale, x: 0, y: Math.max(0, (image.height * scale - stage.height) / 2) };
}

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
