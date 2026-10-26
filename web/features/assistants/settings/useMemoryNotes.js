import { useCallback, useEffect, useState } from "react";

// The next page of a listing read from `offset`: where it starts and how many notes
// it brings (as many as this page, at most those left).
const nextPage = (listing, offset) =>
  Number.isInteger(listing?.nextOffset) && Number.isInteger(listing?.total)
    ? {
        offset: listing.nextOffset,
        count: Math.min(listing.total - listing.nextOffset, listing.nextOffset - offset),
      }
    : null;
const filesOf = (listing) => (Array.isArray(listing?.files) ? listing.files : []);

/**
 * An agent's memory notes as the server pages them (newest first, 200 a page, the
 * Dream diary heading the first): `notes` is null while the first page loads,
 * `nextCount` is how many notes the next page brings (0 on the last) and `loadMore`
 * appends it.
 * `fetchPage(offset)` must be stable; a change of it or of `reloadKey` starts over.
 */
export default function useMemoryNotes(fetchPage, reloadKey) {
  const [notes, setNotes] = useState(null),
    [next, setNext] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setNext(null);
    setError("");
    fetchPage(0).then(
      (listing) => {
        if (!active) return;
        setNotes(filesOf(listing));
        setNext(nextPage(listing, 0));
      },
      (e) => {
        if (!active) return;
        setNotes([]);
        setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [fetchPage, reloadKey]);
  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true);
    try {
      const listing = await fetchPage(next.offset);
      // A note written meanwhile shifts the pages: a name already shown stays once.
      setNotes((shown) => {
        const names = new Set((shown || []).map((note) => note.name));
        return [...(shown || []), ...filesOf(listing).filter((n) => !names.has(n.name))];
      });
      setNext(nextPage(listing, next.offset));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, next, loading]);
  return {
    notes,
    nextCount: next?.count ?? 0,
    loadMore,
    loading,
    error,
  };
}
