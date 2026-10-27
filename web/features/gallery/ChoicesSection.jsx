import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import FilterChips from "../../components/FilterChips.jsx";
import LanguageSelect from "../../components/LanguageSelect.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import Segmented from "../../components/Segmented.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { options } from "./gallery-fixtures.js";

export default function ChoicesSection() {
  const s = copy.sample;
  const choices = options().filter((option) => !option.disabled);
  const [segment, setSegment] = useState("a");
  const [chip, setChip] = useState("running");
  const [segmented, setSegmented] = useState("b");
  const [tab, setTab] = useState("1");
  const [anchored, setAnchored] = useState("a");
  const [searchable, setSearchable] = useState("b");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const tabs = Array.from({ length: 7 }, (_, index) => ({
    id: String(index + 1),
    label: s.tab(index + 1),
    count: index === 1 ? 3 : undefined,
  }));
  return (
    <GallerySection id="choices">
      <Specimen label="FilterChips" wide>
        <FilterChips
          label={s.filterChips}
          value={chip}
          onChange={setChip}
          options={[
            { value: "running", label: s.chipRunning, count: 18 },
            { value: "waiting", label: s.chipWaiting, count: 2, dot: "waiting" },
            { value: "working", label: s.chipWorking, count: 5, dot: "working" },
            { value: "stopped", label: s.chipStopped, count: 6, dot: "pending" },
          ]}
        />
      </Specimen>
      <Specimen label="Segment">
        <Segment
          label={s.segment}
          options={choices}
          value={segment}
          onChange={setSegment}
        />
      </Specimen>
      <Specimen label="Segmented">
        <Segmented
          label={s.segmented}
          options={choices}
          value={segmented}
          onChange={setSegmented}
        />
      </Specimen>
      <Specimen label="UnderlineTabs" wide>
        <UnderlineTabs
          label={s.tabs}
          idPrefix="gallery"
          tabs={tabs}
          selected={tab}
          onSelect={setTab}
        />
        <div
          role="tabpanel"
          id={`gallery-tabpanel-${tab}`}
          aria-labelledby={`gallery-tab-${tab}`}
          className="gallery-tabpanel"
        >
          {s.tab(tab)}
        </div>
      </Specimen>
      <Specimen label="AnchoredSelect" wide>
        <label className="gallery-field">
          {s.anchored}
          <AnchoredSelect
            label={s.anchored}
            value={anchored}
            onChange={setAnchored}
            options={options()}
          />
        </label>
        <label className="gallery-field">
          {s.searchable}
          <AnchoredSelect
            label={s.searchable}
            value={searchable}
            onChange={setSearchable}
            options={choices}
            searchLabel={s.search}
            query={query}
            onQuery={setQuery}
            noMatches={s.noMatches}
          />
        </label>
      </Specimen>
      <Specimen label="SearchSelect" wide>
        <SearchSelect
          label={s.searchSelect}
          searchLabel={s.search}
          placeholder={s.searchPlaceholder}
          value={searched}
          options={choices}
          onChange={setSearched}
        />
      </Specimen>
      <Specimen label="LanguageSelect" wide>
        <LanguageSelect />
      </Specimen>
    </GallerySection>
  );
}
