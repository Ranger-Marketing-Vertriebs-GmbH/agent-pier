import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChatDraft, deliveryScope } from "./chat-draft.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";
import { chatDeliveryCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function useChatDelivery({ session, request, active }) {
  const scope = deliveryScope(session);
  const draft = useMemo(
    () =>
      new ChatDraft(
        {
          getItem: (key) => window.localStorage.getItem(key),
          setItem: (key, value) => window.localStorage.setItem(key, value),
          removeItem: (key) => window.localStorage.removeItem(key),
          key: (index) => window.localStorage.key(index),
          get length() {
            return window.localStorage.length;
          },
        },
        scope,
        (name, operation) =>
          navigator.locks
            ? navigator.locks.request(name, operation)
            : Promise.reject(new Error(copy.lockUnavailable)),
      ),
    [scope],
  );
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const operation = useRef(null);
  const checkVersion = useRef(0);
  const id = state.outbox?.id;
  useEffect(() => {
    const changed = (event) => {
      if (event.key?.startsWith(draft.key)) draft.reload();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [draft]);
  useEffect(() => () => operation.current?.abort(), [draft]);
  const check = useCallback(
    async (signal) => {
      const pending = draft.getSnapshot().outbox;
      if (!pending || operation.current) return;
      const version = ++checkVersion.current;
      try {
        const result = await request(
          `/sessions/${session.id}/input/${pending.id}?scope=${encodeURIComponent(scope)}`,
          "GET",
          undefined,
          signal,
        );
        if (
          version === checkVersion.current &&
          !signal?.aborted &&
          draft.getSnapshot().outbox?.id === pending.id &&
          result.deliveryId === pending.id &&
          ["absent", "pending", "handed-off", "rejected", "uncertain"].includes(
            result.status,
          )
        )
          await draft.receipt(result);
      } catch {
        // A failed status read says nothing about native delivery. Retain custody.
      }
    },
    [draft, request, session.id, scope],
  );
  useEffect(() => {
    if (!active || !id) return;
    return startVisiblePolling(check, 2500);
  }, [active, id, check]);

  const send = async (messages = []) => {
    if (operation.current) return;
    const old = draft.getSnapshot().outbox;
    if (old && old.status !== "absent") return;
    const controller = new AbortController();
    operation.current = controller;
    checkVersion.current++;
    setSending(true);
    setSendError("");
    let item, timeout;
    try {
      item = old || (await draft.enqueue(crypto.randomUUID(), messages));
      if (!item || !["waiting", "absent"].includes(item.status)) return;
      timeout = setTimeout(() => controller.abort(), 15000);
      const result = await request(
        `/sessions/${session.id}/input`,
        "POST",
        {
          text: item.text,
          submit: true,
          deliveryId: item.id,
          deliveryScope: item.scope,
        },
        controller.signal,
      );
      checkVersion.current++;
      if (draft.getSnapshot().outbox?.id === item.id) {
        if (
          result.deliveryId === item.id &&
          ["handed-off", "pending", "uncertain", "rejected"].includes(result.status)
        )
          await draft.receipt(result);
        else
          await draft.receipt({
            deliveryId: item.id,
            status: "checking",
            error: copy.disconnected,
          });
      }
    } catch (error) {
      if (!item) setSendError(copy.prepareFailed);
      if (item && draft.getSnapshot().outbox?.id === item.id)
        await draft.receipt({
          deliveryId: item.id,
          status: "checking",
          error: controller.signal.aborted ? copy.timeout : error.message,
        });
    } finally {
      clearTimeout(timeout);
      operation.current = null;
      setSending(false);
      await check();
    }
  };

  return {
    ...state,
    storageError: state.storageError || sendError,
    draft,
    sending,
    send,
    check: () => check(),
    setText: (text) => draft.change({ text }),
    setAttachments: (update) => {
      const previous = draft.getSnapshot().attachments;
      draft.change({
        attachments: typeof update === "function" ? update(previous) : update,
      });
    },
    locked: Boolean(state.outbox),
  };
}
