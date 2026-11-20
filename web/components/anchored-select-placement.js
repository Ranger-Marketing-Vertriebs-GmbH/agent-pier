// Placement of AnchoredSelect's menu. The menu sits in a fixed layer (anchored-select.css)
// so that no scroll container, card or sticky bar clips or covers it; these helpers turn
// the field's on-screen box into the menu's position in that layer.

const gap = 6;
const maxHeight = 260;
// Below the field unless less than this fits there and more fits above.
const preferBelow = 180;

/**
 * Where the menu goes. `field` and `origin` (the fixed layer's top-left corner) are
 * client rects; `top` and `bottom` bound the room (viewport or dialog). `scale` is the
 * CSS zoom of the field, since the layer's lengths are zoomed too. Returns the menu's
 * position in layer pixels; `above` menus are moved up by their own height in CSS.
 */
export function menuPlacement({ field, origin, scale = 1, top, bottom }) {
  const up = field.top - top,
    down = bottom - field.bottom,
    above = down < preferBelow && up > down;
  const room = Math.max(0, Math.min(maxHeight, (above ? up : down) - gap));
  return {
    above,
    height: room / scale,
    top: ((above ? field.top - gap : field.bottom + gap) - origin.top) / scale,
    left: (field.left - origin.left) / scale,
    width: field.width / scale,
  };
}

/** The part of the viewport that the scroll containers around `element` show. */
export function scrollClip(element) {
  let top = -Infinity,
    bottom = Infinity;
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowY === "visible" && style.overflowX === "visible") continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    if (node.tagName === "DIALOG") break;
  }
  return { top, bottom };
}
