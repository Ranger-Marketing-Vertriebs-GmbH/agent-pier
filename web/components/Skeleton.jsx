import React from "react";
import { skeletonCopy } from "../lib/i18n/messages/components.js";
import "./skeleton.css";

/**
 * A grey placeholder with a slow shimmer where content is still loading, sized like
 * that content so nothing moves when it arrives (docs/ui-guide.md#feedback).
 * `shape="text"` (the default) is one line of the surrounding font, `width` long:
 * put it in the element the text will fill and it takes that line's height.
 * `shape="block"` is a box of `width` × `height` (a mark, a button, a sparkline),
 * `shape="circle"` a round one (an avatar). Always `aria-hidden`; the busy region
 * carries one `SkeletonLabel` and `aria-busy="true"`.
 */
export default function Skeleton({ shape = "text", width, height, className = "" }) {
  return (
    <span
      aria-hidden="true"
      className={["skeleton", `skeleton-${shape}`, className].filter(Boolean).join(" ")}
      style={{ width, height }}
    >
      {shape === "text" ? " " : null}
    </span>
  );
}

/**
 * "Loading" for assistive technology, once per busy region. Plain text, not a live
 * region: it is read when the reader reaches the region, never announced again.
 */
export function SkeletonLabel() {
  return <span className="visually-hidden">{skeletonCopy.loading}</span>;
}
