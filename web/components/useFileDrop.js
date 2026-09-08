import { useEffect, useState } from "react";
import "./file-drop.css";

// Touch-only devices keep their existing file picker. File drags are consumed
// even when disabled so the browser cannot navigate away from unsaved input.
export default function useFileDrop({ enabled, onFiles }) {
  const [dragging, setDragging] = useState(false);
  const [desktop, setDesktop] = useState(
    () => window.matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const changed = () => {
      setDesktop(media.matches);
      setDragging(false);
    };
    const clear = () => setDragging(false);
    media.addEventListener("change", changed);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      media.removeEventListener("change", changed);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const files = (event) => Array.from(event.dataTransfer.types).includes("Files");
  return {
    "data-file-drop": true,
    "data-dropping": (dragging && desktop && enabled) || undefined,
    onDragOverCapture(event) {
      if (!files(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = desktop && enabled ? "copy" : "none";
      setDragging(true);
    },
    onDragLeave(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    },
    onDropCapture(event) {
      if (!files(event) && !event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      if (!desktop || !enabled) return;
      const selected = Array.from(event.dataTransfer.files);
      if (selected.length) onFiles(selected);
    },
  };
}
