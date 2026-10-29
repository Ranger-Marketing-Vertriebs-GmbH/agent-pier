import { useEffect, useLayoutEffect, useRef } from "react";
import { anchorToChild, followEnd } from "./transcript-scroll.js";

/**
 * How an agent chat's transcript scrolls (AssistantChat.jsx): it opens at its newest
 * message and follows new content while the reader is at the bottom, keeps the
 * reader's place when an older page is prepended (`prepended`, set before it lands),
 * and a team link anchors the team's request or latest note. Returns the refs the
 * chat shares: `output` (the transcript), `stick` (follow the end) and `prepended`.
 */
export default function useTranscriptScroll({
  conversationId,
  focusTeamId,
  live,
  messages,
  requests,
  delta,
  busy,
  notes,
}) {
  const output = useRef(null);
  const stick = useRef(true);
  const scroll = useRef(0);
  // The transcript's distance from its end before an older page was prepended.
  const prepended = useRef(null);
  // An older page lands above what the reader sees, which keeps its place.
  useLayoutEffect(() => {
    const element = output.current;
    const distance = prepended.current;
    prepended.current = null;
    if (!element || distance === null) return;
    element.scrollTop = element.scrollHeight - distance;
    scroll.current = element.scrollTop;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, [messages]);
  // Follow the newest content only while the reader is at the bottom. Team notes count:
  // they arrive with the team list, apart from the history.
  useLayoutEffect(() => {
    const element = output.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
    scroll.current = element.scrollTop;
  }, [messages, requests, delta, busy, notes]);
  // A chat opens at its newest message and keeps it in view while late content (images,
  // cards, the on-screen keyboard) changes sizes, until the reader scrolls away.
  useLayoutEffect(() => {
    if (!output.current) return undefined;
    stick.current = true;
    return followEnd(output.current, stick, scroll, () => unanchor.current !== null);
  }, [conversationId]);
  // A team link (/agents/:id/teams/:teamId) shows what the team needs from the owner,
  // or else its latest note, once the history is rendered (not just received) and either
  // is there; it stays there while late content shifts, until the reader moves.
  const focused = useRef("");
  const unanchor = useRef(null);
  useEffect(() => () => unanchor.current?.(), []);
  useEffect(() => {
    if (!focusTeamId || focused.current === focusTeamId || !live) return;
    const element = output.current;
    const target =
      element?.querySelector(`#assistant-team-${CSS.escape(focusTeamId)}`) ||
      element?.querySelector(`#assistant-team-requests-${CSS.escape(focusTeamId)}`) ||
      element?.querySelector(`#assistant-team-review-${CSS.escape(focusTeamId)}`) ||
      [...(element?.querySelectorAll(".assistant-team-note") || [])].findLast(
        (note) => note.dataset.team === focusTeamId,
      );
    if (!target) return;
    focused.current = focusTeamId;
    stick.current = false;
    const release = () => (unanchor.current = null);
    unanchor.current = anchorToChild(element, target, () => !stick.current, release);
  });
  return { output, stick, prepended };
}
