import { nativeDeliveryStates } from "./native-delivery-state.js";
import useChatStream from "./useChatStream.js";
import useChatDelivery from "./useChatDelivery.js";
import useChatAttachments from "./useChatAttachments.js";
import { withReadyUploads } from "./chat-upload-send.js";
import { deliveryScope } from "./chat-draft.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { chatAttachmentCopy as attachmentCopy } from "../../lib/i18n/messages/chat.js";
export default function useChatController({ active, session, request, onConnection }) {
  const [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    [picking, setPicking] = useState(false);
  const [touchInput, setTouchInput] = useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
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
  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setTouchInput(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const output = useRef(null),
    outputHeight = useRef(0),
    stick = useRef(true),
    scroll = useRef(0);
  const stream = useChatStream({ active, session, request, onConnection, output, stick });
  const { data, loadError } = stream;
  useEffect(() => {
    if (data?.messages && delivery.recent.length)
      void delivery.draft.observeMessages(data.messages);
  }, [data, delivery.draft, delivery.recent]);
  useLayoutEffect(() => {
    const element = output.current;
    if (!active || !element) return;
    outputHeight.current = element.clientHeight;
    element.scrollTop = stick.current ? element.scrollHeight : scroll.current;
    // Keyboard animation and composer growth resize the message viewport without
    // changing the transcript. Follow its bottom only while already following.
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
      outputHeight.current = element.clientHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (active && stick.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [data, active, delivery.outbox, delivery.recent]);
  async function submit(event) {
    event.preventDefault();
    if (
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
    setError("");
    setSent(false);
    stick.current = true;
    try {
      await withReadyUploads(deliveryScope(session), () =>
        delivery.send(data?.messages || []),
      );
    } catch (err) {
      setError(err.message);
    }
  }

  const choose = (result) => {
    stream.choose(result);
    setPicking(false);
  };
  return {
    data,
    historyError: stream.historyError,
    historyLoading: stream.historyLoading,
    loadOlder: stream.loadOlder,
    delivery: {
      ...delivery,
      nativeStates: nativeDeliveryStates(
        [...delivery.recent, ...(delivery.outbox ? [delivery.outbox] : [])],
        data?.messages || [],
        data?.nativeInput?.providerSessionId === data?.providerSessionId
          ? data?.nativeInput
          : null,
        session.tool,
        session.status === "running" && !data?.observability?.stale,
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
