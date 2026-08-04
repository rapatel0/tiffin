// SPDX-License-Identifier: MIT
// The editor: ProseMirror state, plugins, keymaps, and the command surface the
// toolbar drives. Nothing here knows about files or UI chrome.

import { EditorState, type Command, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Node as PMNode, DOMSerializer } from 'prosemirror-model'
import { baseKeymap, chainCommands, setBlockType, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, redo, undo } from 'prosemirror-history'
import {
  ellipsis,
  emDash,
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { columnResizing, goToNextCell, tableEditing } from 'prosemirror-tables'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'

import { schema } from './schema.ts'
import { paginationPlugin } from './paginate.ts'
import { bodyRev, defaultPageSetup, emptyReview, pageBox, type PageSetup, type Review, type TiffinDoc } from './model.ts'
import { getReview, REVIEW_META, reviewPlugin, setReview } from './review.ts'

const nodes = schema.nodes
const marks = schema.marks

/** Insert a forced page break — the one break that lives in the document. */
export const insertPageBreak: Command = (state, dispatch) => {
  const { $from } = state.selection
  if (!$from.parent.type.contentMatch.matchType(nodes.page_break)) {
    // Not insertable here (inside a table cell, say). Say no rather than
    // producing a document that fails validation.
    if (!nodes.doc.contentMatch.matchType(nodes.page_break)) return false
  }
  if (dispatch) {
    const br = nodes.page_break.create()
    dispatch(state.tr.replaceSelectionWith(br).scrollIntoView())
  }
  return true
}

export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const cells = () => Array.from({ length: cols }, () => nodes.table_cell.createAndFill()!)
    const header = Array.from({ length: cols }, () => nodes.table_header.createAndFill()!)
    const body = Array.from({ length: rows - 1 }, () => nodes.table_row.create(null, cells()))
    const table = nodes.table.create(null, [nodes.table_row.create(null, header), ...body])
    if (dispatch) dispatch(state.tr.replaceSelectionWith(table).scrollIntoView())
    return true
  }
}

export const commands = {
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  underline: toggleMark(marks.underline),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  paragraph: setBlockType(nodes.paragraph),
  heading: (level: number): Command => setBlockType(nodes.heading, { level }),
  bulletList: wrapInList(nodes.bullet_list),
  orderedList: wrapInList(nodes.ordered_list),
  liftList: liftListItem(nodes.list_item),
  blockquote: (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const { $from } = state.selection
    const range = $from.blockRange(state.selection.$to)
    if (!range) return false
    if (dispatch) dispatch(state.tr.wrap(range, [{ type: nodes.blockquote }]))
    return true
  },
  codeBlock: setBlockType(nodes.code_block),
  rule: (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView())
    return true
  },
  pageBreak: insertPageBreak,
  undo,
  redo,
}

function buildInputRules() {
  return inputRules({
    rules: [
      ...smartQuotes,
      ellipsis,
      emDash,
      // "> " → blockquote
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      // "1. " → ordered list
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
      ),
      // "- " / "* " → bullet list
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      // "```" → code block
      textblockTypeInputRule(/^```$/, nodes.code_block),
      // "### " → heading
      textblockTypeInputRule(new RegExp('^(#{1,6})\\s$'), nodes.heading, (match) => ({ level: match[1].length })),
    ],
  })
}

function buildKeymap(): Record<string, Command> {
  const keys: Record<string, Command> = {
    'Mod-b': commands.bold,
    'Mod-i': commands.italic,
    'Mod-u': commands.underline,
    'Mod-Shift-x': commands.strike,
    'Mod-`': commands.code,
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-Shift-8': commands.bulletList,
    'Mod-Shift-9': commands.orderedList,
    'Mod-Shift-.': commands.blockquote,
    'Mod-Alt-0': commands.paragraph,
    // Word's gesture for a forced page break.
    'Mod-Enter': insertPageBreak,
    'Shift-Mod-Enter': insertPageBreak,
    Enter: splitListItem(nodes.list_item),
    Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  }
  for (let level = 1; level <= 6; level++) keys[`Mod-Alt-${level}`] = commands.heading(level)
  return keys
}

export interface WriterHost {
  /** Fires whenever the document content changes (not on decoration passes). */
  onChange(): void
  onPages(pages: number): void
  /** Fires when comments or suggestions change, so the panel can redraw. */
  onReview?(): void
}

/**
 * Owns the live document. The envelope (title, pageSetup, docId) lives here;
 * the prose lives in the ProseMirror state. `snapshot()` is the only place the
 * two are joined, and it is what gets written to disk.
 */
export class Writer {
  readonly view: EditorView
  private envelope: Omit<TiffinDoc, 'body'>
  private setupRef: PageSetup
  /** Holds the generated @page rule. See applyGeometry(). */
  private pageStyle: HTMLStyleElement | null = null

  constructor(mount: HTMLElement, doc: TiffinDoc, private host: WriterHost) {
    const { body, ...envelope } = doc
    this.envelope = envelope
    this.setupRef = doc.pageSetup

    const content = body ? PMNode.fromJSON(schema, body) : undefined
    const state = EditorState.create({
      schema,
      doc: content,
      plugins: [
        buildInputRules(),
        keymap(buildKeymap()),
        keymap(baseKeymap),
        history(),
        dropCursor({ class: 'tf-dropcursor' }),
        gapCursor(),
        columnResizing(),
        tableEditing(),
        reviewPlugin(doc.review, body),
        paginationPlugin({
          setup: () => this.setupRef,
          onPages: (pages) => this.host.onPages(pages),
        }),
      ],
    })

    this.view = new EditorView(mount, {
      state,
      attributes: { class: 'tf-prose', spellcheck: 'true' },
      dispatchTransaction: (tr) => {
        const before = getReview(this.view.state).review
        this.view.updateState(this.view.state.apply(tr))
        const after = getReview(this.view.state).review
        if (tr.docChanged) this.host.onChange()
        if (after !== before) {
          // Annotations are document content: adding one dirties the file even
          // when not a character of prose has changed.
          if (!tr.docChanged) this.host.onChange()
          this.host.onReview?.()
        }
      },
    })
  }

  // ── review ────────────────────────────────────────────────────────────────

  get review(): Review {
    return getReview(this.view.state).review
  }

  get reviewState() {
    return getReview(this.view.state)
  }

  /** Apply a patch to the review state and let the host redraw. */
  patchReview(patch: Parameters<typeof setReview>[1]): void {
    this.view.dispatch(setReview(this.view.state, patch))
  }

  setReviewData(review: Review): void {
    this.patchReview({ review })
  }

  /** Hash of the prose as it stands — the merge precondition. */
  currentRev(): string {
    return bodyRev(this.view.state.doc.toJSON())
  }

  get pageSetup(): PageSetup {
    return this.setupRef
  }

  setPageSetup(next: PageSetup): void {
    this.setupRef = next
    this.applyGeometry()
    this.host.onChange()
  }

  get title(): string {
    return this.envelope.title
  }

  setTitle(title: string): void {
    this.envelope.title = title
    document.title = `${title} — Tiffin`
    this.host.onChange()
  }

  /**
   * Push page geometry into CSS custom properties. The stylesheet, the bands and
   * the print rules all read the same four numbers, so there is exactly one
   * source of truth for how wide a page is.
   */
  applyGeometry(): void {
    const s = this.setupRef
    const box = pageBox(s)
    const root = document.documentElement.style
    root.setProperty('--tf-page-w', `${box.width}px`)
    root.setProperty('--tf-page-h', `${box.height}px`)
    root.setProperty('--tf-margin-top', `${s.margin.top}px`)
    root.setProperty('--tf-margin-right', `${s.margin.right}px`)
    root.setProperty('--tf-margin-bottom', `${s.margin.bottom}px`)
    root.setProperty('--tf-margin-left', `${s.margin.left}px`)
    root.setProperty('--tf-gap', `${s.gap}px`)
    // ── print geometry ──────────────────────────────────────────────────────
    // @page CANNOT read custom properties. Descriptors in the page context do
    // not inherit from :root, so `size: var(--tf-print-w) …` is silently
    // dropped and the paper falls back to whatever the print system defaults to
    // — verified the hard way: an A4 document printed as five Letter pages,
    // because once the page box is the wrong size our computed break positions
    // no longer line up and the engine repaginates from scratch.
    //
    // So the rule is generated with literal millimetres, and regenerated
    // whenever the geometry changes. It is marked transient like every other
    // runtime injection, so it can never end up in a saved file.
    const mm = (px: number) => `${((px / 96) * 25.4).toFixed(4)}mm`
    if (!this.pageStyle) {
      this.pageStyle = document.createElement('style')
      this.pageStyle.setAttribute('data-tf-transient', '')
      document.head.appendChild(this.pageStyle)
    }
    this.pageStyle.textContent =
      `@page{size:${mm(box.width)} ${mm(box.height)};` +
      `margin:${mm(s.margin.top)} ${mm(s.margin.right)} ${mm(s.margin.bottom)} ${mm(s.margin.left)}}`
  }

  /**
   * The full document, ready to write to disk.
   *
   * Review anchors come from plugin state rather than the envelope, because
   * that is where they have been kept live: every transaction since load has
   * mapped them through its own changes. The envelope's copy is stale by
   * definition the moment anyone types.
   */
  snapshot(): TiffinDoc {
    const review = this.review
    const empty =
      !Object.keys(review.comments).length &&
      !Object.keys(review.suggestions).length &&
      !Object.keys(review.people).length
    return {
      ...this.envelope,
      pageSetup: this.setupRef,
      body: this.view.state.doc.toJSON(),
      modified: new Date().toISOString(),
      // Absent until someone annotates — an untouched document should not grow
      // an empty review block just for having opened in a build that has one.
      ...(empty ? { review: undefined } : { review }),
    }
  }

  /** Replace the document from JSON — the AI round-trip entry point. Undoable. */
  loadDoc(next: TiffinDoc): void {
    const { body, ...envelope } = next
    this.envelope = envelope
    this.setupRef = next.pageSetup ?? defaultPageSetup()
    const content = body ? PMNode.fromJSON(schema, body) : schema.topNodeType.createAndFill()!
    content.check()
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, content.content)
    // The incoming review describes the incoming body, so it replaces rather
    // than merges — mapping the old anchors through a whole-document swap would
    // produce positions into prose that no longer exists.
    tr.setMeta(REVIEW_META, { review: next.review ?? emptyReview(bodyRev(body)), active: null })
    this.view.dispatch(tr)
    this.applyGeometry()
    document.title = `${this.envelope.title} — Tiffin`
  }

  /**
   * A static, script-free rendering of the document — the same schema→DOM
   * mapping the editor uses, so a thumbnail can never disagree with the page.
   */
  renderStatic(): HTMLElement {
    const host = document.createElement('div')
    host.className = 'tf-static'
    host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(this.view.state.doc.content))
    return host
  }

  focus(): void {
    this.view.focus()
  }
}
