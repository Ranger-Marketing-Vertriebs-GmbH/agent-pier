import { useCallback, useEffect, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { assistantApi } from "./assistant-api.js";

const none = [];

/**
 * The owner's undecided memory review cards (server memory-reviews.js). Each card is
 * an inbox item, so the live `inbox` topic tells when they change; the cards are read
 * only while it lists one. `reload()` reads them again after a decision.
 */
export default function useMemoryReviews() {
  const inbox = useLiveTopic("inbox");
  const signature = (inbox.data?.items || none)
    .filter((item) => item.type === "memory-review")
    .map((item) => `${item.id}:${item.revision}`)
    .join("|");
  // `read`: the signature the shown cards were read for.
  const [state, setState] = useState({ reviews: none, error: "", read: "" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!signature) {
      setState({ reviews: none, error: "", read: "" });
      return;
    }
    let live = true;
    assistantApi.memoryReviews().then(
      (next) =>
        live && setState({ reviews: next.reviews || none, error: "", read: signature }),
      (e) =>
        live &&
        setState((current) => ({ ...current, error: e.message, read: signature })),
    );
    return () => {
      live = false;
    };
  }, [signature, tick]);
  const { refresh } = inbox;
  const reload = useCallback(() => {
    setTick((n) => n + 1);
    return refresh();
  }, [refresh]);
  const loading = (!inbox.data && !inbox.error) || state.read !== signature;
  return { reviews: state.reviews, error: state.error, loading, reload };
}
