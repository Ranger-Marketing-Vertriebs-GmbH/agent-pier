import useLiveTopic from "../../lib/live/useLiveTopic.js";

/**
 * The open previews of sessions and agents (`previews` topic): `data` is the
 * `GET /api/previews` answer, `{ settings, previews, slots, serve }`.
 */
export default function usePreviews() {
  const { data, error, written } = useLiveTopic("previews");
  return { data, error, written };
}
