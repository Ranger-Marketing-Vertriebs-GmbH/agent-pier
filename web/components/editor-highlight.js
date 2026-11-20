import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// The syntax colours of web/styles/base.css. Each keeps WCAG AA on --syntax-bg.
export const syntaxTokens = [
  "--syntax-text",
  "--syntax-keyword",
  "--syntax-string",
  "--syntax-number",
  "--syntax-property",
  "--syntax-function",
  "--syntax-type",
  "--syntax-tag",
  "--syntax-attribute",
  "--syntax-comment",
  "--syntax-punctuation",
  "--syntax-meta",
  "--syntax-link",
  "--syntax-invalid",
];

const color = (name) => `var(--syntax-${name})`;

// CodeMirror's default highlight style is made for light backgrounds; the app is
// dark, so editors use this style built on the theme tokens instead.
export const editorHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: color("keyword"),
  },
  { tag: [t.definitionKeyword, t.modifier, t.self], color: color("keyword") },
  {
    tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape],
    color: color("string"),
  },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.literal, t.unit, t.color],
    color: color("number"),
  },
  {
    tag: [t.propertyName, t.variableName, t.labelName, t.special(t.variableName)],
    color: color("property"),
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.macroName,
    ],
    color: color("function"),
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)],
    color: color("type"),
  },
  { tag: [t.tagName, t.angleBracket], color: color("tag") },
  { tag: [t.attributeName], color: color("attribute") },
  { tag: [t.attributeValue], color: color("string") },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: color("comment"),
    fontStyle: "italic",
  },
  {
    tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator],
    color: color("punctuation"),
  },
  {
    tag: [t.meta, t.processingInstruction, t.documentMeta, t.annotation],
    color: color("meta"),
  },
  { tag: t.heading, color: color("meta"), fontWeight: "bold" },
  { tag: [t.link, t.url], color: color("link"), textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.quote, t.contentSeparator], color: color("comment") },
  { tag: [t.inserted], color: color("string") },
  { tag: [t.deleted, t.invalid], color: color("invalid") },
  { tag: [t.changed], color: color("type") },
]);

export const editorHighlighting = () => syntaxHighlighting(editorHighlightStyle);
