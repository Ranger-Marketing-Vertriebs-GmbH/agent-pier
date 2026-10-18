import React, { useState } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import ListCard from "../../components/ListCard.jsx";
import {
  CheckboxRow,
  NumberRow,
  RadioRow,
  SelectRow,
  ToggleRow,
} from "../../components/ListRow.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { options } from "./gallery-fixtures.js";

export default function ControlsSection() {
  const s = copy.sample;
  const [toggle, setToggle] = useState(true);
  const [number, setNumber] = useState(5);
  const [select, setSelect] = useState("a");
  const [radio, setRadio] = useState("a");
  const [checkbox, setCheckbox] = useState(true);
  const [check, setCheck] = useState(false);
  return (
    <GallerySection id="controls">
      <Specimen label="ToggleRow · NumberRow · SelectRow · RadioRow · CheckboxRow" wide>
        <ListCard label={copy.sections.controls}>
          <ToggleRow
            label={s.toggle}
            sub={s.toggleSub}
            checked={toggle}
            onChange={setToggle}
          />
          <ToggleRow
            label={copy.variants.disabled}
            checked={false}
            onChange={setToggle}
            disabled
          />
          <NumberRow
            label={s.number}
            value={number}
            min={1}
            max={10}
            onChange={setNumber}
          />
          <SelectRow
            label={s.select}
            value={select}
            options={options().filter((option) => !option.disabled)}
            onChange={setSelect}
          />
          <RadioRow
            name="gallery-radio"
            label={s.radioA}
            value="a"
            checked={radio === "a"}
            onChange={setRadio}
          />
          <RadioRow
            name="gallery-radio"
            label={s.radioB}
            value="b"
            checked={radio === "b"}
            onChange={setRadio}
          />
          <CheckboxRow
            label={s.checkbox}
            pill={s.pill}
            checked={checkbox}
            onChange={setCheckbox}
          />
        </ListCard>
      </Specimen>
      <Specimen label="CheckRow" wide>
        <CheckRow
          title={s.checkRow}
          subtitle={s.checkRowSub}
          checked={check}
          onChange={(event) => setCheck(event.target.checked)}
        />
        <CheckRow title={copy.variants.disabled} checked readOnly disabled />
      </Specimen>
    </GallerySection>
  );
}
