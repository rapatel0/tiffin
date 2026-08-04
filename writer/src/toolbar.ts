// SPDX-License-Identifier: MIT
// The app chrome. Everything this module builds lives under ONE
// data-tf-transient root, which is the whole reason save.ts can strip runtime
// DOM with a single selector instead of a growing list of exceptions.

import { toggleMark } from 'prosemirror-commands'
import { schema } from './schema.ts'
import { commands, insertTable, type Writer } from './editor.ts'
import { PAPER, type PaperName, type PageSetup } from './model.ts'
import { invalidatePagination } from './paginate.ts'

export interface ChromeHost {
  save(): void
  saveAs(): void
  copyJson(): void
  replaceJson(): void
  print(): void
}

interface Btn {
  label: string
  title: string
  run: (w: Writer) => void
  active?: (w: Writer) => boolean
}

function markActive(w: Writer, mark: string): boolean {
  const { state } = w.view
  const type = schema.marks[mark]
  const { from, $from, to, empty } = state.selection
  return empty ? !!type.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, type)
}

const GROUPS: Btn[][] = [
  [
    { label: '↶', title: 'Undo (⌘Z)', run: (w) => commands.undo(w.view.state, w.view.dispatch) },
    { label: '↷', title: 'Redo (⇧⌘Z)', run: (w) => commands.redo(w.view.state, w.view.dispatch) },
  ],
  [
    {
      label: 'B',
      title: 'Bold (⌘B)',
      run: (w) => toggleMark(schema.marks.strong)(w.view.state, w.view.dispatch),
      active: (w) => markActive(w, 'strong'),
    },
    {
      label: 'I',
      title: 'Italic (⌘I)',
      run: (w) => toggleMark(schema.marks.em)(w.view.state, w.view.dispatch),
      active: (w) => markActive(w, 'em'),
    },
    {
      label: 'U',
      title: 'Underline (⌘U)',
      run: (w) => toggleMark(schema.marks.underline)(w.view.state, w.view.dispatch),
      active: (w) => markActive(w, 'underline'),
    },
    {
      label: 'S',
      title: 'Strikethrough (⇧⌘X)',
      run: (w) => toggleMark(schema.marks.strike)(w.view.state, w.view.dispatch),
      active: (w) => markActive(w, 'strike'),
    },
  ],
  [
    { label: '•', title: 'Bullet list (⇧⌘8)', run: (w) => commands.bulletList(w.view.state, w.view.dispatch) },
    { label: '1.', title: 'Numbered list (⇧⌘9)', run: (w) => commands.orderedList(w.view.state, w.view.dispatch) },
    { label: '❝', title: 'Blockquote (⇧⌘.)', run: (w) => commands.blockquote(w.view.state, w.view.dispatch) },
    { label: '⌗', title: 'Code block', run: (w) => commands.codeBlock(w.view.state, w.view.dispatch) },
  ],
  [
    { label: '▦', title: 'Insert 3×3 table', run: (w) => insertTable(3, 3)(w.view.state, w.view.dispatch) },
    { label: '―', title: 'Horizontal rule', run: (w) => commands.rule(w.view.state, w.view.dispatch) },
    { label: '⤓', title: 'Page break (⌘⏎)', run: (w) => commands.pageBreak(w.view.state, w.view.dispatch) },
  ],
]

export function buildChrome(writer: Writer, host: ChromeHost): { root: HTMLElement; setPages(n: number): void; setDirty(d: boolean): void } {
  const root = document.createElement('div')
  root.id = 'tf-app'
  root.setAttribute('data-tf-transient', '')

  // --- top bar ---------------------------------------------------------------
  const bar = document.createElement('div')
  bar.className = 'tf-bar'

  const title = document.createElement('input')
  title.className = 'tf-title'
  title.value = writer.title
  title.spellcheck = false
  title.setAttribute('aria-label', 'Document title')
  title.addEventListener('input', () => writer.setTitle(title.value || 'Untitled'))
  bar.appendChild(title)

  const spacer = document.createElement('div')
  spacer.className = 'tf-spacer'
  bar.appendChild(spacer)

  const styleSelect = document.createElement('select')
  styleSelect.className = 'tf-select'
  styleSelect.title = 'Paragraph style'
  for (const [label, value] of [
    ['Body text', 'p'],
    ['Heading 1', 'h1'],
    ['Heading 2', 'h2'],
    ['Heading 3', 'h3'],
    ['Heading 4', 'h4'],
  ] as const) {
    const opt = document.createElement('option')
    opt.textContent = label
    opt.value = value
    styleSelect.appendChild(opt)
  }
  styleSelect.addEventListener('change', () => {
    const v = styleSelect.value
    if (v === 'p') commands.paragraph(writer.view.state, writer.view.dispatch)
    else commands.heading(Number(v.slice(1)))(writer.view.state, writer.view.dispatch)
    writer.focus()
  })
  bar.appendChild(styleSelect)

  const buttons: Array<{ el: HTMLButtonElement; spec: Btn }> = []
  for (const group of GROUPS) {
    const g = document.createElement('div')
    g.className = 'tf-group'
    for (const spec of group) {
      const b = document.createElement('button')
      b.className = 'tf-btn'
      b.textContent = spec.label
      b.title = spec.title
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => {
        spec.run(writer)
        writer.focus()
        sync()
      })
      g.appendChild(b)
      buttons.push({ el: b, spec })
    }
    bar.appendChild(g)
  }

  // --- page setup ------------------------------------------------------------
  const paper = document.createElement('select')
  paper.className = 'tf-select'
  paper.title = 'Paper size'
  for (const name of Object.keys(PAPER)) {
    const opt = document.createElement('option')
    opt.textContent = name
    opt.value = name
    paper.appendChild(opt)
  }
  paper.value = writer.pageSetup.paper

  const orient = document.createElement('select')
  orient.className = 'tf-select'
  orient.title = 'Orientation'
  for (const [label, value] of [
    ['Portrait', 'portrait'],
    ['Landscape', 'landscape'],
  ] as const) {
    const opt = document.createElement('option')
    opt.textContent = label
    opt.value = value
    orient.appendChild(opt)
  }
  orient.value = writer.pageSetup.orientation

  const applySetup = () => {
    const next: PageSetup = {
      ...writer.pageSetup,
      paper: paper.value as PaperName,
      orientation: orient.value as 'portrait' | 'landscape',
    }
    writer.setPageSetup(next)
    invalidatePagination()
  }
  paper.addEventListener('change', applySetup)
  orient.addEventListener('change', applySetup)

  const pageGroup = document.createElement('div')
  pageGroup.className = 'tf-group'
  pageGroup.append(paper, orient)
  bar.appendChild(pageGroup)

  // --- file actions ----------------------------------------------------------
  const fileGroup = document.createElement('div')
  fileGroup.className = 'tf-group'
  for (const [label, title, fn] of [
    ['Save', 'Save (⌘S)', () => host.save()],
    ['Save as…', 'Save a copy (⇧⌘S)', () => host.saveAs()],
    ['Print', 'Print / PDF (⌘P)', () => host.print()],
    ['Copy JSON', 'Copy the document JSON for an AI assistant', () => host.copyJson()],
    ['Paste JSON', 'Replace the document from JSON', () => host.replaceJson()],
  ] as const) {
    const b = document.createElement('button')
    b.className = 'tf-btn tf-btn-text'
    b.textContent = label
    b.title = title
    b.addEventListener('click', fn)
    fileGroup.appendChild(b)
  }
  bar.appendChild(fileGroup)
  root.appendChild(bar)

  // --- page surface ----------------------------------------------------------
  const scroll = document.createElement('div')
  scroll.className = 'tf-scroll'
  const column = document.createElement('div')
  column.className = 'tf-column'
  scroll.appendChild(column)
  root.appendChild(scroll)

  // --- status bar ------------------------------------------------------------
  const status = document.createElement('div')
  status.className = 'tf-status'
  const pagesEl = document.createElement('span')
  const dirtyEl = document.createElement('span')
  dirtyEl.className = 'tf-dirty'
  const wordsEl = document.createElement('span')
  status.append(pagesEl, wordsEl, dirtyEl)
  root.appendChild(status)

  const sync = () => {
    for (const { el, spec } of buttons) el.classList.toggle('is-active', spec.active?.(writer) ?? false)
    const text = writer.view.state.doc.textBetween(0, writer.view.state.doc.content.size, ' ', ' ')
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    wordsEl.textContent = `${words} word${words === 1 ? '' : 's'}`
  }

  return {
    root,
    setPages: (n) => {
      pagesEl.textContent = `${n} page${n === 1 ? '' : 's'}`
      sync()
    },
    setDirty: (d) => {
      dirtyEl.textContent = d ? 'Unsaved changes' : 'Saved'
      dirtyEl.classList.toggle('is-dirty', d)
      sync()
    },
  }
}

/** Where the editor mounts, once the chrome exists. */
export const columnOf = (root: HTMLElement): HTMLElement => root.querySelector('.tf-column') as HTMLElement
