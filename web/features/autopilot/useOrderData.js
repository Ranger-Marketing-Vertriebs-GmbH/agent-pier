import { useEffect, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { liveClient } from "../../lib/live/live-client.js";
import { orderSourceTopics } from "./order-source-topics.js";

export default function useOrderData(orderId, sessions) {
  const path = orderId
    ? `/autopilot/orders/${encodeURIComponent(orderId)}`
    : "/autopilot/orders";
  const resource = useLiveTopic("autopilot.orders.changed", path);
  const { invalidate } = resource;
  const orders = orderId
    ? resource.data
      ? [resource.data]
      : []
    : (resource.data?.orders ?? []);
  // Keys depend on identities, so a refreshed view does not resubscribe itself.
  const sourceKey = JSON.stringify(orderSourceTopics(orders, Boolean(orderId)));
  useEffect(() => {
    const client = liveClient();
    const stops = JSON.parse(sourceKey).map((topic) =>
      client.subscribe(topic, (event) => {
        if (["data", "changed", "stale", "revoked"].includes(event.type)) invalidate();
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [sourceKey, invalidate]);
  // The workspace already watches state. Reconcile sessions that stopped or
  // disappeared even when the order file and the inbox have not changed.
  const ids = new Set(orders.map((order) => order.session?.id).filter(Boolean));
  const sessionKey = JSON.stringify(
    sessions
      .filter((s) => ids.has(s.id))
      .map((s) => [s.id, s.status])
      .sort(),
  );
  const previous = useRef(null);
  useEffect(() => {
    if (previous.current !== null && sessionKey !== previous.current) invalidate();
    previous.current = sessionKey;
  }, [sessionKey, invalidate]);
  return resource;
}
