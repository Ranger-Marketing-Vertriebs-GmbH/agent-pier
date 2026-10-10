import useTouchInput from "./useTouchInput.js";
import { nativeDeliveryStates } from "./native-delivery-state.js";
import { assertChatSnapshot } from "./chat-sync.js";
import useChatStream from "./useChatStream.js";
import useChatDelivery from "./useChatDelivery.js";
import useChatAttachments from "./useChatAttachments.js";
import { withReadyUploads } from "./chat-upload-send.js";
import { deliveryScope } from "./chat-draft.js";
import { restoreScrollAnchor, scrollAnchor } from "./chat-scroll-anchor.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { chatAttachmentCopy as attachmentCopy } from "../../lib/i18n/messages/chat.js";
export default function useChatController({ active, session, request, onConnection }) {
  const [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    [picking, setPicking] = useState(false);
  const touchInput = useTouchInput();
  const [modelPending, setModelPending] = useState(false);
  const delivery = useChatDelivery({ session, request, active });
  const { text, setText } = delivery;
  const busy = delivery.sending;
  const attachmentState = useChatAttachments({
    session,
    request,
    draft: delivery.draft,
    disabled: busy || modelPending || delivery.locked,
    attachments: delivery.attachments,
    setAttachments: delivery.setAttachments,
  });
  const { attachments, uploading } = attachmentState;
  const [tasksOpen, setTasksOpen] = useState(
    () => !window.matchMedia("(max-width: 900px)").matches,
  );
  const [compactTasks, setCompactTasks] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const taskTrigger = useRef(null),
    taskOpener = useRef(null),
    taskId = useId();
  const closeTasks = () => {
    setTasksOpen(false);
    const opener = taskOpener.current?.isConnected
      ? taskOpener.current
      : taskTrigger.current;
    opener?.focus();
  };
  const openTasks = (event) => {
    taskOpener.current = event?.currentTarget || taskTrigger.current;
    setTasksOpen(true);
  };
  const toggleTasks = (event) => {
    if (tasksOpen) closeTasks();
    else openTasks(event);
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setCompactTasks(media.matches);
      setTasksOpen(!media.matches);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // Synchronous guard: a double Enter must not start a second send before state updates.
  const submitting = useRef(false);
  const output = useRef(null),
    outputHeight = useRef(0),
    stick = useRef(true),
    scroll = useRef(0);
  const stream = useChatStream({ active, session, request, onConnection, output, stick });
  const { data, loadError, restored, restoreScroll, followBottom, saveScroll } = stream;
  // Cached rows are not server evidence: deliveries are judged on live frames only.
  useEffect(() => {
    if (delivery.reset && !data?.restored)
      void delivery.draft.observeReset(data, session.restartGeneration || 0);
  }, [data, delivery.draft, delivery.reset, session.restartGeneration]);
  useEffect(() => {
    if (data?.messages && !data.restored && delivery.recent.length)
      void delivery.draft.observeMessages(data.messages);
  }, [data, delivery.draft, delivery.recent]);
  useLayoutEffect(() => {
    const element = output.current;
    if (!active || !element) return;
    outputHeight.current = element.clientHeight;
    const saved = restoreScroll.current;
    restoreScroll.current = null;
    if (saved) stick.current = !restoreScrollAnchor(element, saved);
    if (saved && !stick.current) scroll.current = element.scrollTop;
    else element.scrollTop = stick.current ? element.scrollHeight : scroll.current;
    // Keyboard animation and composer growth resize the message viewport without
    // changing the transcript. Follow its bottom only while already following.
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
      outputHeight.current = element.clientHeight;
    });
    observer.observe(element);
    // Only a laid-out view has a position worth keeping; the cache is update-only.
    const keep = (urgent) => {
      if (element.clientHeight > 0)
        saveScroll(scrollAnchor(element, stick.current), urgent);
    };
    const hide = () => {
      if (document.visibilityState === "hidden") keep(true);
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", hide);
      keep(false);
    };
  }, [active, restoreScroll, saveScroll]);
  useLayoutEffect(() => {
    // Follow the committed transcript before a queued scroll event can mistake
    // its new height for a user scrolling away from the bottom.
    if (!active || !output.current) return;
    // A cached chat adopted after the mount brings its own saved position.
    const late = data?.restored ? restoreScroll.current : null;
    if (late) {
      restoreScroll.current = null;
      stick.current = !restoreScrollAnchor(output.current, late);
      if (!stick.current) {
        scroll.current = output.current.scrollTop;
        return;
      }
    }
    if (followBottom.current) {
      followBottom.current = false;
      stick.current = true;
    }
    if (stick.current) output.current.scrollTop = output.current.scrollHeight;
  }, [data, active, delivery.outbox, delivery.recent, followBottom, restoreScroll]);
  const send = (messages) =>
    delivery.send(messages, {
      tool: session.tool,
      providerSessionId:
        data?.availability === "ready" && !data.restored && !data.observability?.stale
          ? data.providerSessionId
          : null,
      restartGeneration: session.restartGeneration || 0,
    });
  async function submit(event) {
    event.preventDefault();
    if (
      submitting.current ||
      session.pipeline?.headless ||
      (!text.trim() && !attachments.length) ||
      busy ||
      modelPending ||
      uploading ||
      attachmentState.blocked ||
      delivery.locked ||
      session.status !== "running"
    )
      return;
    const message = [text, ...attachments.map((file) => file.path)].join("\n");
    if (message.length > 32000) {
      setError(attachmentCopy.tooLong);
      return;
    }
    submitting.current = true;
    setError("");
    setSent(false);
    stick.current = true;
    try {
      await withReadyUploads(deliveryScope(session), () => send(data?.messages || []));
    } catch (err) {
      setError(err.message);
    } finally {
      submitting.current = false;
    }
  }

  const choose = async (result) => {
    assertChatSnapshot(result);
    await delivery.draft.dismissReset();
    stream.choose(result);
    setPicking(false);
  };
  return {
    data,
    historyError: stream.historyError,
    historyLoading: stream.historyLoading,
    loadOlder: stream.loadOlder,
    restored,
    delivery: {
      ...delivery,
      send,
      nativeStates: restored
        ? new Map()
        : nativeDeliveryStates(
            [...delivery.recent, ...(delivery.outbox ? [delivery.outbox] : [])],
            data?.messages || [],
            data?.nativeInput?.providerSessionId === data?.providerSessionId
              ? data?.nativeInput
              : null,
            session.tool,
            session.status === "running",
          ),
    },
    tasksOpen,
    closeTasks,
    taskId,
    compactTasks,
    taskTrigger,
    openTasks,
    toggleTasks,
    setPicking,
    output,
    outputHeight,
    scroll,
    stick,
    picking,
    choose,
    loadError,
    error: delivery.storageError || error,
    setModelPending,
    submit,
    text,
    setText,
    setSent,
    touchInput,
    sent,
    busy,
    modelPending,
    attachments: attachmentState,
  };
}
