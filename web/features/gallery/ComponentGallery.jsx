import React, { useState } from "react";
import SaveBar from "../../components/SaveBar.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow } from "../../components/ListRow.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { SubpageFrame } from "../settings/SettingsFrame.jsx";
import ActionsSection from "./ActionsSection.jsx";
import ChoicesSection from "./ChoicesSection.jsx";
import ControlsSection from "./ControlsSection.jsx";
import FeedbackSection from "./FeedbackSection.jsx";
import { GallerySection, sectionIds, Specimen } from "./GallerySection.jsx";
import LayoutSection from "./LayoutSection.jsx";
import ListsSection from "./ListsSection.jsx";
import OverlaysSection from "./OverlaysSection.jsx";
import { noop, sampleDraft } from "./gallery-fixtures.js";
import "./gallery.css";

const saveStates = ["hidden", "dirty", "saving", "error", "conflict", "partial"];

// Settings › Operations › Development › Components: every shared component from
// web/components with its variants and states, on fixture data (docs/ui-guide.md).
export default function ComponentGallery({ frame }) {
  const [saveState, setSaveState] = useState("dirty");
  return (
    <SubpageFrame
      frame={frame}
      title={copy.title}
      bar={<SaveBar draft={sampleDraft(saveState)} onSave={noop} onOverwrite={noop} />}
    >
      <div className="component-gallery">
        <p className="gallery-intro">{copy.intro}</p>
        <nav className="gallery-contents" aria-label={copy.contents}>
          {sectionIds.map((id) => (
            <a
              key={id}
              href={`#gallery-${id}`}
              onClick={(event) => {
                // In-page scrolling; the route keeps its address without a hash.
                event.preventDefault();
                document
                  .getElementById(`gallery-${id}`)
                  ?.scrollIntoView({ block: "start" });
              }}
            >
              {copy.sections[id]}
            </a>
          ))}
        </nav>
        <ActionsSection />
        <ListsSection />
        <ControlsSection />
        <ChoicesSection />
        <FeedbackSection />
        <OverlaysSection />
        <LayoutSection />
        <GallerySection id="saveBar">
          <Specimen label="SaveBar" wide>
            <ListCard label={copy.saveStates.label}>
              <SelectRow
                label={copy.saveStates.label}
                options={saveStates.map((value) => ({
                  value,
                  label: copy.saveStates[value],
                }))}
                value={saveState}
                onChange={setSaveState}
              />
            </ListCard>
          </Specimen>
        </GallerySection>
      </div>
    </SubpageFrame>
  );
}
