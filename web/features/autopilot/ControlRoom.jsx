import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { appCopy } from "../../lib/i18n/messages/app.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { autopilotActionsCopy } from "../../lib/i18n/messages/autopilot-actions.js";
import { controlRoomCopy as copy } from "../../lib/i18n/messages/control-room.js";
import { routePath } from "../../app/routes.js";
import { joinFacts, statusText } from "./order-presentation.js";
import NewOrder from "./NewOrder.jsx";
import OrderControls from "./OrderControls.jsx";
import OrderDashboard from "./OrderDashboard.jsx";
import useOrderData from "./useOrderData.js";
import "./control-room.css";

const overview = { view: "control-room" };
const detailRoute = (orderId) => ({ ...overview, orderId });
const groups = ["waiting", "active", "paused", "draft", "completed", "unknown"];

function orderContext(order, orders) {
  const namesake = orders.some(
    (other) =>
      other.id !== order.id &&
      other.title === order.title &&
      other.projectId === order.projectId,
  );
  const project = orders.some(
    (other) =>
      other.projectId !== order.projectId && other.projectName === order.projectName,
  )
    ? order.projectRoot
    : order.projectName;
  return joinFacts(
    project || order.projectRoot || order.projectId,
    namesake && order.id,
    order.nextAction,
  );
}

function OrderList({ orders, navigate }) {
  if (!orders.length) return <p className="control-room-empty">{copy.empty}</p>;
  return groups.map((state) => {
    const entries = orders.filter(
      (order) => (groups.includes(order.state) ? order.state : "unknown") === state,
    );
    if (!entries.length) return null;
    const heading = `order-group-${state}`;
    return (
      <section key={state} aria-labelledby={heading} className="order-list-group">
        <GroupLabel id={heading}>
          {statusText(state)} <span className="order-group-count">{entries.length}</span>
        </GroupLabel>
        <ListCard labelledBy={heading}>
          {entries.map((order) => (
            <ListRow
              key={order.id}
              icon={<Icon name="folder" size={17} />}
              label={order.title}
              sub={orderContext(order, orders)}
              href={routePath(detailRoute(order.id))}
              onClick={() => navigate(detailRoute(order.id))}
            />
          ))}
        </ListCard>
      </section>
    );
  });
}

export default function ControlRoom({
  route,
  state,
  ready,
  refreshWorkspace,
  navigate,
  openNavigation,
  navigationOpen,
}) {
  const resource = useOrderData(route.orderId, state.sessions);
  const detail = Boolean(route.orderId);
  const order = detail && resource.data;
  const back = () => navigate(overview);
  const project = order && (order.projectName || order.projectRoot || order.projectId);
  async function created(result) {
    // Back from Composer reopens its order, including when the form was a deep link.
    await navigate(detailRoute(result.id), true);
    if (result.session?.id) {
      await refreshWorkspace().catch(() => {});
      await navigate({ view: "workspace", sessionId: result.session.id, mode: "reader" });
    }
  }
  return (
    <SettingsShell
      className="control-room"
      title={detail ? order?.title || copy.order : copy.title}
      description={project || (!detail && copy.description)}
      subtitle={project}
      leading={detail ? "back" : "menu"}
      onLeading={detail ? back : openNavigation}
      leadingLabel={detail ? copy.back : undefined}
      navigationOpen={navigationOpen}
      actions={
        !detail && (
          <button
            type="button"
            className="button primary"
            disabled={!ready}
            onClick={() => navigate({ ...overview, creating: true })}
          >
            {autopilotActionsCopy.newOrder}
          </button>
        )
      }
    >
      {resource.error && (
        <div className="order-read-error">
          <ErrorMessage error={resource.error} />
          <button type="button" className="button secondary" onClick={resource.refresh}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {!resource.data && !resource.error && (
        <p className="loading" role="status">
          {copy.loading}
        </p>
      )}
      {order && (
        <OrderDashboard
          key={order.id}
          order={order}
          navigate={navigate}
          controls={
            <OrderControls
              key={order.id}
              state={state}
              order={order}
              onUpdated={resource.written}
              onRemoved={back}
            />
          }
        />
      )}
      {!detail && resource.data && (
        <OrderList orders={resource.data.orders} navigate={navigate} />
      )}
      {route.creating && !ready && <p role="status">{appCopy.workspaceLoading}</p>}
      {route.creating && ready && (
        <NewOrder
          state={state}
          onCancel={back}
          onCreated={created}
          onOpenOrder={(id) => navigate(detailRoute(id))}
        />
      )}
    </SettingsShell>
  );
}
