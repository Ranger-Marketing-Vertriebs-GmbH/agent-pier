import React, { useRef, useState } from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import ConfirmAction from "./ConfirmAction.jsx";

// Leaving an edited draft through the page asks first instead of discarding it.
// `guarded(go)` runs `go` at once while the draft is clean.
export default function useDraftGuard(description) {
  const [leaving, setLeaving] = useState(null),
    [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const guarded = (go) => (dirtyRef.current ? setLeaving(() => go) : go());
  const confirm = leaving && (
    <ConfirmAction
      description={description}
      label={copy.discard}
      close={() => setLeaving(null)}
      action={() => {
        setLeaving(null);
        setDirty(false);
        dirtyRef.current = false;
        leaving();
      }}
    />
  );
  return { setDirty, guarded, confirm };
}
