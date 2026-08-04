// SPDX-License-Identifier: MIT
// The ProseMirror schema — which is also the renderer.
//
// Every node's toDOM is used by THREE surfaces: the live editor view, the
// static save-time preview (via DOMSerializer), and print. That is the property
// we chose ProseMirror for, and it holds only as long as we avoid nodeViews
// whose live rendering diverges from toDOM.
//
// ONE structural addition to the standard set: `pageBreak`. It is the only page
// break that belongs in the document, because it is the only one the user
// asked for. Automatic breaks are decorations (see paginate.ts).

import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { schema as basic } from 'prosemirror-schema-basic'
import { addListNodes } from 'prosemirror-schema-list'
import { tableNodes } from 'prosemirror-tables'

const pageBreak: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  parseDOM: [{ tag: 'div[data-page-break]' }],
  toDOM: () => ['div', { 'data-page-break': 'true', class: 'tf-forced-break' }],
}

const underline: MarkSpec = {
  parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
  toDOM: () => ['u', 0],
}

const strike: MarkSpec = {
  parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
  toDOM: () => ['s', 0],
}

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {
    background: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.backgroundColor || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `${(attrs.style as string) ?? ''}background-color:${value};`
      },
    },
  },
})

export const schema = new Schema({
  nodes: addListNodes(basic.spec.nodes, 'paragraph block*', 'block')
    .append({ page_break: pageBreak })
    .append(tables),
  marks: basic.spec.marks.append({ underline, strike }),
})

/** Node types the paginator treats as a hard break request. */
export const isForcedBreak = (typeName: string): boolean => typeName === 'page_break'
