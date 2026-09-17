import { useEffect, useRef } from "react";

export default function useExplorerPreviewReturn(file) {
  const explorerRef = useRef(null);
  const previewOrigin = useRef(null);
  const previousFile = useRef(file);
  useEffect(() => {
    if (previousFile.current && !file) {
      const origin = previewOrigin.current;
      requestAnimationFrame(() => {
        if (origin?.element?.isConnected) origin.element.focus({ preventScroll: true });
        if (explorerRef.current && origin)
          explorerRef.current.scrollTop = origin.scrollTop;
      });
    }
    previousFile.current = file;
  }, [file]);
  return { explorerRef, previewOrigin };
}
