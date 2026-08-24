// SPDX-License-Identifier: MIT
// The ProseMirror schema — which is also the renderer.
//
// Every node's toDOM is used by THREE surfaces: the live editor view, the
// static save-time preview (via DOMSerializer), and print. That is the property
// we chose ProseMirror for. Mermaid is the one derived view: its node stores
// source, toDOM preserves that source, and mermaid.ts derives the same SVG for
// editor and static output.
//
// Two structural additions to the standard set:
//
// - `page_break` stores a page break that the author requested.
// - `mermaid_diagram` stores Mermaid source as data. The runtime derives SVG.
//
// Automatic page breaks and rendered SVG never enter the document JSON.

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

const mermaidDiagram: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  attrs: {
    source: { default: 'flowchart LR\n  A --> B', validate: 'string' },
  },
  parseDOM: [
    {
      tag: 'figure[data-mermaid-diagram]',
      getAttrs: (dom) => ({
        source: (dom as HTMLElement).querySelector('.tf-mermaid-source')?.textContent ?? '',
      }),
    },
  ],
  toDOM: (node) => [
    'figure',
    { 'data-mermaid-diagram': 'true', class: 'tf-mermaid' },
    ['pre', { class: 'tf-mermaid-source' }, String(node.attrs.source)],
  ],
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
    .append({ mermaid_diagram: mermaidDiagram })
    .append(tables),
  marks: basic.spec.marks.append({ underline, strike }),
})

/** Node types the paginator treats as a hard break request. */
export const isForcedBreak = (typeName: string): boolean => typeName === 'page_break'
