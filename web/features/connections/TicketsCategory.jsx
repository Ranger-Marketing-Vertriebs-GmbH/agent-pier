import React from "react";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import PlaneConnectionsPage from "../tickets/PlaneConnectionsPage.jsx";
import CategorySection from "./CategorySection.jsx";
import EmptyCategory from "./EmptyCategory.jsx";

/** Zugänge › Ticketquellen: the Plane connections the Tickets tab reads. */
export function TicketsCategory({ shared }) {
  return (
    <CategorySection title={copy.sections.tickets}>
      <PlaneConnectionsPage
        live={shared.ticketSources}
        onChanged={shared.reloadAll}
        emptyState={(openAdd) => (
          <EmptyCategory
            icon="link"
            title={copy.empty.tickets.title}
            body={copy.empty.tickets.body}
            actions={[{ label: copy.empty.tickets.primary, onClick: openAdd }]}
          />
        )}
      />
    </CategorySection>
  );
}
