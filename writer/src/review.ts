// SPDX-License-Identifier: MIT
// Review: comments and suggestions, anchored beside the prose rather than
// inside it.
//
// WHY ANNOTATIONS ARE NOT MARKS
// The obvious design is a `comment` mark on the covered text — ProseMirror maps
// it through edits for free. It is right for one editor and wrong for a file
// that travels. A suggestion changes the text (an insertion adds characters, a
// deletion strikes them through but keeps them), so a reviewer's body stops
// matching the base and two reviewers' positions stop matching each other.
// Keeping annotations out of band keeps every circulated body byte-identical,
// which is what turns an N-way merge into a union of keyed maps.
// See docs/SPRINT-002.md.
//
// WHY POSITIONS STILL HAVE TO MAP
// The base is frozen for REVIEWERS. The owner edits with comments on screen, so
// anchors move as they type. Anchors therefore live in plugin state and are
// mapped through tr.mapping on every transaction; snapshot() reads them back.
// The file stores the position as of the last save, the session keeps it live,
// and ProseMirror's own mapping does all the arithmetic.
//
// WHY RENDERING IS DECORATIONS
// Highlights, strike-through and proposed text are computed from stored intent
// at open time. Invariant 3: only the claim ("this remark belongs to this
// range") is stored; everything visible about it is derived.

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Comment, Review, Suggestion } from './model.ts'
import { bodyRev, emptyReview, newAnnotationId } from './model.ts'

export const reviewKey = new PluginKey<ReviewState>('tiffin-review')

/** Set on a transaction to replace part of the review state. */
export const REVIEW_META = 'tiffin-review-set'

export interface ReviewState {
  review: Review
  /** Which annotation is focused in the panel, for highlighting. */
  active: string | null
  visible: boolean
}

const PALETTE = ['#2f7d4f', '#9c4221', '#2b6cb0', '#6b46c1', '#b7791f', '#a4133c']

export function pickColor(existing: Record<string, { color: string }>): string {
  const used = new Set(Object.values(existing).map((p) => p.color))
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[Object.keys(existing).length % PALETTE.length]
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map every anchor through a transaction.
 *
 * The `assoc` arguments make the range EXCLUSIVE at both ends: `from` biases
 * right (+1) and `to` biases left (-1), so text typed at either edge lands
 * outside the annotation instead of silently widening it. Getting this backwards
 * is easy and looks fine — the anchor still tracks the text, it just quietly
 * swallows whatever you type next to it. test/review.test.ts pins both edges.
 *
 * A range whose ends cross over has had its text deleted; it is clamped to a
 * zero-width anchor and left for the staleness check to surface, rather than
 * dropped. Losing a remark because someone edited the sentence it was about is
 * the worst outcome available here.
 */
function mapAnchors<T extends { from: number; to: number }>(
  items: Record<string, T>,
  tr: Transaction,
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [id, item] of Object.entries(items)) {
    const from = tr.mapping.map(item.from, 1)
    const to = tr.mapping.map(item.to, -1)
    out[id] = { ...item, from: Math.min(from, to), to: Math.max(from, to) }
  }
  return out
}

/** The text a range currently covers, for comparison against `quote`. */
export function textAt(state: EditorState, from: number, to: number): string {
  const size = state.doc.content.size
  if (from < 0 || to > size || from > to) return ''
  return state.doc.textBetween(from, to, ' ', ' ')
}

/**
 * An annotation is stale when the prose it described has changed underneath it.
 * A zero-width anchor with a non-empty quote means the text was deleted
 * outright; otherwise compare what is there now with what was there then.
 */
export function isStale(state: EditorState, a: { from: number; to: number; quote: string }): boolean {
  if (!a.quote) return false
  return textAt(state, a.from, a.to) !== a.quote
}

// ─────────────────────────────────────────────────────────────────────────────
// Decorations
// ─────────────────────────────────────────────────────────────────────────────

function proposedWidget(text: string, color: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'tf-sug-ins'
  el.setAttribute('data-tf-transient', '')
  el.contentEditable = 'false'
  el.style.setProperty('--tf-annot', color)
  el.textContent = text
  return el
}

function build(state: EditorState, rs: ReviewState): DecorationSet {
  if (!rs.visible) return DecorationSet.empty
  const { review, active } = rs
  const decos: Decoration[] = []
  const colorOf = (author: string) => review.people[author]?.color ?? PALETTE[0]

  for (const [id, c] of Object.entries(review.comments)) {
    if (c.resolved || c.threadOf) continue
    if (c.from === c.to) continue
    decos.push(
      Decoration.inline(c.from, c.to, {
        class: `tf-cmt${active === id ? ' tf-annot-active' : ''}${isStale(state, c) ? ' tf-annot-stale' : ''}`,
        style: `--tf-annot:${colorOf(c.author)}`,
      }),
    )
  }

  for (const [id, s] of Object.entries(review.suggestions)) {
    if (s.status !== 'open') continue
    const color = colorOf(s.author)
    const cls = `${active === id ? ' tf-annot-active' : ''}${isStale(state, s) ? ' tf-annot-stale' : ''}`
    if (s.kind !== 'insert' && s.from !== s.to) {
      decos.push(
        Decoration.inline(s.from, s.to, {
          class: `tf-sug-del${cls}`,
          style: `--tf-annot:${color}`,
        }),
      )
    }
    if (s.kind !== 'delete' && s.text) {
      // side:1 so the proposal reads after the text it replaces.
      decos.push(Decoration.widget(s.to, () => proposedWidget(s.text, color), { side: 1, key: `sug:${id}:${s.text}` }))
    }
  }

  return DecorationSet.create(state.doc, decos)
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

export function reviewPlugin(initial: Review | undefined, body: unknown): Plugin<ReviewState> {
  return new Plugin<ReviewState>({
    key: reviewKey,
    state: {
      init: () => ({ review: initial ?? emptyReview(bodyRev(body)), active: null, visible: true }),
      apply: (tr, prev) => {
        const set = tr.getMeta(REVIEW_META) as Partial<ReviewState> | undefined
        let next = set ? { ...prev, ...set } : prev
        if (tr.docChanged) {
          next = {
            ...next,
            review: {
              ...next.review,
              comments: mapAnchors(next.review.comments, tr),
              suggestions: mapAnchors(next.review.suggestions, tr),
            },
          }
        }
        return next
      },
    },
    props: {
      decorations: (state) => build(state, reviewKey.getState(state)!),
    },
  })
}

export const getReview = (state: EditorState): ReviewState => reviewKey.getState(state)!

/** Replace part of the review state. Never added to history — annotations are
 *  not prose, and undo should not resurrect a resolved comment. */
export function setReview(state: EditorState, patch: Partial<ReviewState>): Transaction {
  return state.tr.setMeta(REVIEW_META, patch).setMeta('addToHistory', false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoring
// ─────────────────────────────────────────────────────────────────────────────

export interface Author {
  id: string
  person: { name: string; color: string }
}

function withPerson(review: Review, author: Author): Record<string, { name: string; color: string }> {
  return { ...review.people, [author.id]: author.person }
}

export function addComment(state: EditorState, author: Author, body: string, threadOf: string | null = null): Transaction | null {
  const { from, to } = state.selection
  const rs = getReview(state)
  // A reply inherits its root's anchor; a fresh comment needs a real selection.
  const root = threadOf ? rs.review.comments[threadOf] : null
  if (!threadOf && from === to) return null
  const id = newAnnotationId('c')
  const comment: Comment = {
    author: author.id,
    created: new Date().toISOString(),
    from: root ? root.from : from,
    to: root ? root.to : to,
    quote: root ? root.quote : textAt(state, from, to),
    threadOf,
    resolved: false,
    body,
  }
  return setReview(state, {
    active: id,
    review: {
      ...rs.review,
      people: withPerson(rs.review, author),
      comments: { ...rs.review.comments, [id]: comment },
    },
  })
}

export function addSuggestion(state: EditorState, author: Author, text: string): Transaction | null {
  const { from, to } = state.selection
  const rs = getReview(state)
  const kind: Suggestion['kind'] = from === to ? 'insert' : text ? 'replace' : 'delete'
  if (kind === 'insert' && !text) return null
  const id = newAnnotationId('s')
  const suggestion: Suggestion = {
    author: author.id,
    created: new Date().toISOString(),
    from,
    to,
    quote: textAt(state, from, to),
    kind,
    text,
    status: 'open',
  }
  return setReview(state, {
    active: id,
    review: {
      ...rs.review,
      people: withPerson(rs.review, author),
      suggestions: { ...rs.review.suggestions, [id]: suggestion },
    },
  })
}

export function resolveComment(state: EditorState, id: string, resolved = true): Transaction | null {
  const rs = getReview(state)
  const c = rs.review.comments[id]
  if (!c) return null
  const comments = { ...rs.review.comments, [id]: { ...c, resolved } }
  // Resolving a root resolves its replies; a half-resolved thread is noise.
  for (const [rid, r] of Object.entries(comments)) {
    if (r.threadOf === id) comments[rid] = { ...r, resolved }
  }
  return setReview(state, { review: { ...rs.review, comments } })
}

// ─────────────────────────────────────────────────────────────────────────────
// Settling suggestions
// ─────────────────────────────────────────────────────────────────────────────

export type SettleResult = { ok: true; tr: Transaction } | { ok: false; reason: string }

/**
 * Accept a suggestion: apply it to the prose, then record it settled.
 *
 * One transaction does both, so the anchor mapping in apply() rebases every
 * other annotation through the same change for free. That is the whole reason
 * this is not two dispatches.
 */
export function acceptSuggestion(state: EditorState, id: string): SettleResult {
  const rs = getReview(state)
  const s = rs.review.suggestions[id]
  if (!s) return { ok: false, reason: 'no such suggestion' }
  if (s.status !== 'open') return { ok: false, reason: 'already settled' }
  if (isStale(state, s)) return { ok: false, reason: 'the text it applies to has changed' }

  const tr = state.tr
  if (s.kind === 'delete') tr.delete(s.from, s.to)
  else if (s.kind === 'insert') tr.insertText(s.text, s.from)
  else tr.insertText(s.text, s.from, s.to)

  // Read the mapped anchors back out of the transaction, then mark it settled.
  const mapped = mapAnchors(rs.review.suggestions, tr)
  tr.setMeta(REVIEW_META, {
    active: null,
    review: {
      ...rs.review,
      comments: mapAnchors(rs.review.comments, tr),
      suggestions: { ...mapped, [id]: { ...mapped[id], status: 'accepted' as const } },
    },
  })
  return { ok: true, tr }
}

export function rejectSuggestion(state: EditorState, id: string): SettleResult {
  const rs = getReview(state)
  const s = rs.review.suggestions[id]
  if (!s) return { ok: false, reason: 'no such suggestion' }
  return {
    ok: true,
    tr: setReview(state, {
      active: null,
      review: {
        ...rs.review,
        suggestions: { ...rs.review.suggestions, [id]: { ...s, status: 'rejected' } },
      },
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge and purge
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeReport {
  people: number
  comments: number
  suggestions: number
}

/**
 * Union another copy's review into this one.
 *
 * Ids already present win locally — an incoming copy cannot rewrite a remark
 * you already hold, only add to it. Callers must check `baseRev` first; this
 * function trusts that the positions describe the same prose, and there is no
 * way for it to find out on its own.
 */
export function mergeReview(mine: Review, theirs: Review): { review: Review; report: MergeReport } {
  const report: MergeReport = { people: 0, comments: 0, suggestions: 0 }
  const people = { ...mine.people }
  for (const [id, p] of Object.entries(theirs.people)) if (!people[id]) (people[id] = p), report.people++
  const comments = { ...mine.comments }
  for (const [id, c] of Object.entries(theirs.comments)) if (!comments[id]) (comments[id] = c), report.comments++
  const suggestions = { ...mine.suggestions }
  for (const [id, s] of Object.entries(theirs.suggestions)) if (!suggestions[id]) (suggestions[id] = s), report.suggestions++
  return { review: { ...mine, people, comments, suggestions }, report }
}

/** Drop resolved comments and settled suggestions. Invariant 4's tax. */
export function purgeReview(review: Review): { review: Review; removed: number } {
  let removed = 0
  const comments: Record<string, Comment> = {}
  for (const [id, c] of Object.entries(review.comments)) {
    if (c.resolved) removed++
    else comments[id] = c
  }
  const suggestions: Record<string, Suggestion> = {}
  for (const [id, s] of Object.entries(review.suggestions)) {
    if (s.status !== 'open') removed++
    else suggestions[id] = s
  }
  return { review: { ...review, comments, suggestions }, removed }
}

/** Open threads, roots first, each followed by its replies in time order. */
export function threads(review: Review): { root: [string, Comment]; replies: [string, Comment][] }[] {
  const all = Object.entries(review.comments)
  const byTime = (a: [string, Comment], b: [string, Comment]) => a[1].created.localeCompare(b[1].created)
  return all
    .filter(([, c]) => !c.threadOf && !c.resolved)
    .sort((a, b) => a[1].from - b[1].from || byTime(a, b))
    .map((root) => ({
      root,
      replies: all.filter(([, c]) => c.threadOf === root[0] && !c.resolved).sort(byTime),
    }))
}
