import { useMemo } from "react";

/**
 * Several editors on one page share one draft guard (useDraftGuard): the page is dirty
 * while any part is, and "Save and continue" saves every dirty part in order. Returns
 * stable `{ onDirtyChange, onSaver }` props per part key.
 */
export default function useDraftParts(draft, keys) {
  const { setDirty, setSave } = draft;
  const joined = keys.join("\n");
  return useMemo(() => {
    const parts = new Map(joined.split("\n").map((key) => [key, {}]));
    const report = () => {
      const all = [...parts.values()];
      setDirty(all.some((part) => part.dirty));
      setSave(
        all.some((part) => part.save)
          ? async () => {
              for (const part of parts.values())
                if (part.dirty && !(part.save && (await part.save()))) return false;
              return true;
            }
          : null,
      );
    };
    return Object.fromEntries(
      [...parts].map(([key, part]) => [
        key,
        {
          onDirtyChange: (dirty) => {
            part.dirty = dirty;
            report();
          },
          onSaver: (save) => {
            part.save = save;
            report();
          },
        },
      ]),
    );
  }, [joined, setDirty, setSave]);
}
