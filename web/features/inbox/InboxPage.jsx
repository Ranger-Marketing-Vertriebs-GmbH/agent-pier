import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";
import InboxDetail from "./InboxDetail.jsx";
import {
  itemAgentLine,
  itemContext,
  itemIcon,
  itemTime,
  itemTitle,
} from "./inbox-presentation.js";
import { inboxTabs, itemKey } from "./routes.js";
import useInbox from "./useInbox.js";
import "./inbox.css";

function InboxRow({ item }) {
  const time = itemTime(item),
    agent = itemAgentLine(item);
  return (
    <>
      <span className={`inbox-row-icon ${item.type}`} aria-hidden="true">
        <Icon name={itemIcon(item)} size={16} />
      </span>
      <span className="inbox-row-text">
        <strong>{itemTitle(item)}</strong>
        <small>{itemContext(item)}</small>
        {agent && <small className="inbox-row-agent">{agent}</small>}
        <small className={`inbox-row-time${time.urgent ? " urgent" : ""}`}>
          {time.text}
        </small>
      </span>
    </>
  );
}

/**
 * Everything waiting on the owner (route /inbox): tabs with counts, the list, and the
 * selected item's own card in the detail pane, answered there or opened in context.
 */
export default function InboxPage({ route, navigate, openNavigation, navigationOpen }) {
  const inbox = useInbox();
  const tab = route.inboxTab || "all";
  const visible = inbox.items.filter((item) => tab === "all" || item.tab === tab);
  const selectedKey = route.itemType ? `${route.itemType}:${route.itemId}` : "";
  const selected = inbox.items.find((item) => itemKey(item) === selectedKey) || null;
  const open = (key) => {
    const [itemType = "", ...rest] = key ? key.split(":") : [];
    navigate({ view: "inbox", inboxTab: tab, itemType, itemId: rest.join(":") });
  };
  const tabs = inboxTabs.map((id) => ({
    id,
    label: copy.tabs[id],
    ...(inbox.counts ? { count: inbox.counts[id === "all" ? "all" : id] } : {}),
  }));
  return (
    <SettingsShell
      className="inbox-page"
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
      title={copy.title}
      subtitle={copy.subtitle}
      tabs={
        <UnderlineTabs
          label={copy.tabsLabel}
          idPrefix="inbox"
          tabs={tabs}
          selected={tab}
          onSelect={(next) =>
            navigate({
              view: "inbox",
              inboxTab: next,
              itemType: route.itemType,
              itemId: route.itemId,
            })
          }
        />
      }
    >
      <div
        role="tabpanel"
        id={`inbox-tabpanel-${tab}`}
        aria-labelledby={`inbox-tab-${tab}`}
        className="inbox-panel"
      >
        <ErrorMessage error={inbox.error} />
        {inbox.loading ? (
          <p className="loading" role="status">
            {copy.loading}
          </p>
        ) : (
          <>
            {!visible.length && !selectedKey && (
              <p className="inbox-empty" role="status">
                {inbox.items.length ? copy.emptyTab : copy.empty}
              </p>
            )}
            {(visible.length > 0 || selectedKey) && (
              <ListDetail
                className="inbox-list"
                listLabel={copy.listLabel}
                count={visible.length}
                items={visible.map((item) => ({ ...item, id: itemKey(item) }))}
                selectedId={selectedKey}
                onSelect={open}
                renderItem={(item) => <InboxRow item={item} />}
                mobileBackLabel={commonCopy.back}
                detail={
                  selectedKey ? (
                    <InboxDetail
                      key={selectedKey}
                      type={route.itemType}
                      id={route.itemId}
                      item={selected}
                      navigate={navigate}
                      reload={inbox.reload}
                    />
                  ) : (
                    <p className="inbox-select">{copy.select}</p>
                  )
                }
              />
            )}
          </>
        )}
      </div>
    </SettingsShell>
  );
}
