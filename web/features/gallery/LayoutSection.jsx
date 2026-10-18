import React, { useState } from "react";
import ListDetail from "../../components/ListDetail.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { detailItems } from "./gallery-fixtures.js";

// This page itself is the SettingsShell specimen: header, back button, content column
// and the save bar slot.
export default function LayoutSection() {
  const [selected, setSelected] = useState("a");
  const items = detailItems();
  const item = items.find((entry) => entry.id === selected);
  return (
    <GallerySection id="layout">
      <Specimen label="ListDetail" wide>
        <ListDetail
          className="gallery-list-detail"
          listLabel={copy.sample.listDetail}
          count={items.length}
          items={items}
          selectedId={selected}
          onSelect={setSelected}
          renderItem={(entry) => entry.name}
          mobileBackLabel={commonCopy.back}
          detail={item && <p>{copy.sample.detailFor(item.name)}</p>}
        />
      </Specimen>
    </GallerySection>
  );
}
