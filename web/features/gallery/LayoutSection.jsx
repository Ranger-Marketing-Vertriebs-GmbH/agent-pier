import React, { useState } from "react";
import DropZoneOverlay from "../../components/DropZoneOverlay.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import PageHeader from "../../components/PageHeader.jsx";
import SplitLayout from "../../components/SplitLayout.jsx";
import useDropZone from "../../components/useDropZone.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { detailItems } from "./gallery-fixtures.js";

const PANE_TYPE = "application/x-agentpier-pane";
const MIN_PANE = { width: 80, height: 60 };
const keyOf = (leaf) => leaf.id;
const leaf = (id) => ({ type: "pane", id });
const initialSplit = {
  type: "split",
  dir: "row",
  ratio: 0.5,
  a: leaf("one"),
  b: { type: "split", dir: "col", ratio: 0.5, a: leaf("two"), b: leaf("three") },
};
const acceptsPane = (types) => types.includes(PANE_TYPE);

function setAt(node, path, ratio) {
  if (path.length === 0) return { ...node, ratio };
  const [head, ...rest] = path;
  return { ...node, [head]: setAt(node[head], rest, ratio) };
}

function DropZoneSpecimen() {
  const [dropped, setDropped] = useState(null);
  const { side, handlers } = useDropZone({
    accepts: acceptsPane,
    onDrop: (next) => setDropped(next),
  });
  return (
    <div className="gallery-drop-zone" data-testid="drop-zone-specimen" {...handlers}>
      <span>{copy.sample.dropHint}</span>
      <DropZoneOverlay side={side} label={copy.sample.dropHere} />
      <p className="gallery-drop-status" role="status">
        {dropped ? copy.sample.dropped[dropped] : copy.sample.dropIdle}
      </p>
    </div>
  );
}

// This page itself is the SettingsShell specimen: header, back button, content column
// and the save bar slot. PageHeader is the wide overview header (start page).
export default function LayoutSection() {
  const [selected, setSelected] = useState("a");
  const [split, setSplit] = useState(initialSplit);
  const items = detailItems();
  const item = items.find((entry) => entry.id === selected);
  return (
    <GallerySection id="layout">
      <Specimen label="PageHeader" wide>
        <PageHeader
          className="gallery-page-header"
          eyebrow={copy.sample.pageEyebrow}
          title={copy.sample.pageTitle}
          summary={<p>{copy.sample.pageSummary}</p>}
          actions={
            <>
              <button type="button" className="button secondary">
                {copy.variants.secondary}
              </button>
              <button type="button" className="button primary">
                {copy.variants.primary}
              </button>
            </>
          }
        />
      </Specimen>
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
      <Specimen label="SplitLayout" wide>
        <div className="gallery-split">
          <SplitLayout
            layout={split}
            keyOf={keyOf}
            minPane={MIN_PANE}
            onRatio={(path, ratio) => setSplit((current) => setAt(current, path, ratio))}
            renderPane={(entry) => (
              <div className="gallery-split-pane">
                {copy.sample.paneName({ one: 1, two: 2, three: 3 }[entry.id])}
              </div>
            )}
          />
        </div>
      </Specimen>
      <Specimen label="DropZoneOverlay" wide>
        <DropZoneSpecimen />
      </Specimen>
    </GallerySection>
  );
}
