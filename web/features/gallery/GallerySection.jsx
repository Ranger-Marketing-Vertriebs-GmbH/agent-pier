import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";

export const sectionIds = [
  "actions",
  "lists",
  "controls",
  "choices",
  "feedback",
  "overlays",
  "layout",
  "saveBar",
];

// One gallery section: a group label (also the contents' anchor) and its specimens.
export function GallerySection({ id, children }) {
  return (
    <section
      className="gallery-section"
      id={`gallery-${id}`}
      aria-labelledby={`gallery-${id}-title`}
      data-gallery-section={id}
    >
      <GroupLabel id={`gallery-${id}-title`}>{copy.sections[id]}</GroupLabel>
      {children}
    </section>
  );
}

// One component or variant with its caption.
export function Specimen({ label, wide = false, children }) {
  return (
    <div className={wide ? "gallery-specimen wide" : "gallery-specimen"}>
      <p className="gallery-caption">{label}</p>
      <div className="gallery-demo">{children}</div>
    </div>
  );
}
