import { useCallback, useEffect, useRef, useState } from "react";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Form values that follow the saved server record without discarding edits:
// untouched fields adopt newer server values, edited fields stay and are reported
// as conflicts when the server changed them too.
export default function useSyncedForm(server) {
  const [values, setValues] = useState(server);
  const [conflicts, setConflicts] = useState([]);
  const current = useRef(values);
  const base = useRef(server);
  current.current = values;
  const signature = JSON.stringify(server);
  useEffect(() => {
    const next = { ...current.current },
      found = [];
    for (const key of Object.keys(server)) {
      if (same(next[key], server[key]))
        base.current = { ...base.current, [key]: server[key] };
      else if (same(server[key], base.current[key])) continue;
      else if (same(next[key], base.current[key])) {
        next[key] = server[key];
        base.current = { ...base.current, [key]: server[key] };
      } else found.push(key);
    }
    if (!same(next, current.current)) setValues(next);
    setConflicts((previous) => (same(previous, found) ? previous : found));
    // `signature` captures every change of `server`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const set = useCallback(
    (key, value) => setValues((previous) => ({ ...previous, [key]: value })),
    [],
  );
  const reload = useCallback(() => {
    base.current = server;
    setValues(server);
    setConflicts([]);
  }, [server]);
  return { values, set, conflicts, reload };
}
