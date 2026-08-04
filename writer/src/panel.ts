// SPDX-License-Identifier: MIT
// The review rail: comments and suggestions, listed beside the page.
//
// WHY A DOCKED RAIL AND NOT MARGIN BUBBLES
// Bubbles beside their anchor is the nicer design and it is not what ships
// here. The paginator measures every top-level block and assumes the number it
// gets is position-independent (see THE MEASUREMENT CONTRACT in styles.css).
// Anything drawn into the page margin risks changing a measured height, and the
// failure mode is a page that breaks a line early — silent, cumulative, and
// discovered in a PDF. A rail outside .tf-column cannot touch measurement at
// all. The gutter is a deliberate later sprint, not an oversight.

import type { Writer } from './editor.ts'
import type { Comment, Suggestion } from './model.ts'
import {
  acceptSuggestion,
  addComment,
  addSuggestion,
  isStale,
  rejectSuggestion,
  resolveComment,
  threads,
  type Author,
} from './review.ts'

export interface PanelHost {
  author(): Author
  importReview(): void
  purge(): void
  note(text: string, isError?: boolean): void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** "3 minutes ago" is nicer but needs a ticking clock; a short date does not. */
const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function buildPanel(writer: Writer, host: PanelHost): { root: HTMLElement; render(): void; toggle(): boolean } {
  const root = el('aside', 'tf-rail')
  root.setAttribute('data-tf-transient', '')

  const head = el('div', 'tf-rail-head')
  const heading = el('strong', undefined, 'Review')
  const count = el('span', 'tf-rail-count')
  head.append(heading, count)

  const actions = el('div', 'tf-rail-actions')
  for (const [label, title, fn] of [
    ['Import…', 'Merge comments and suggestions from another copy of this file', () => host.importReview()],
    ['Purge', 'Remove resolved comments and settled suggestions', () => host.purge()],
  ] as const) {
    const b = el('button', 'tf-btn tf-btn-text', label)
    b.title = title
    b.addEventListener('click', fn)
    actions.appendChild(b)
  }
  head.appendChild(actions)
  root.appendChild(head)

  const list = el('div', 'tf-rail-list')
  root.appendChild(list)

  // --- composer --------------------------------------------------------------
  const composer = el('form', 'tf-compose') as HTMLFormElement
  const input = el('textarea', 'tf-compose-input') as HTMLTextAreaElement
  input.rows = 2
  input.placeholder = 'Comment on the selected text…'
  const composeRow = el('div', 'tf-compose-row')
  const commentBtn = el('button', 'tf-btn tf-btn-text', 'Comment') as HTMLButtonElement
  commentBtn.type = 'submit'
  const suggestBtn = el('button', 'tf-btn tf-btn-text', 'Suggest') as HTMLButtonElement
  suggestBtn.type = 'button'
  suggestBtn.title = 'Propose this text in place of the selection'
  composeRow.append(commentBtn, suggestBtn)
  composer.append(input, composeRow)
  root.appendChild(composer)

  const focusAnnotation = (id: string, from: number) => {
    writer.patchReview({ active: id })
    const dom = writer.view.domAtPos(Math.min(from, writer.view.state.doc.content.size))
    const node = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    const tr = addComment(writer.view.state, host.author(), text)
    if (!tr) {
      host.note('Select some text first — a comment needs something to point at.', true)
      return
    }
    writer.view.dispatch(tr)
    input.value = ''
  })

  suggestBtn.addEventListener('click', () => {
    const { from, to } = writer.view.state.selection
    if (from === to && !input.value.trim()) {
      host.note('Select text to replace, or type the text you want inserted.', true)
      return
    }
    // Deliberately allow an empty box over a selection: that is a deletion.
    const tr = addSuggestion(writer.view.state, host.author(), input.value.trim())
    if (!tr) return
    writer.view.dispatch(tr)
    input.value = ''
  })

  // --- rendering -------------------------------------------------------------

  function commentCard(id: string, c: Comment, replies: [string, Comment][]): HTMLElement {
    const rs = writer.reviewState
    const card = el('article', 'tf-card')
    if (rs.active === id) card.classList.add('is-active')
    const person = rs.review.people[c.author]
    card.style.setProperty('--tf-annot', person?.color ?? '#666')

    const meta = el('header', 'tf-card-head')
    meta.append(el('span', 'tf-who', person?.name ?? 'Someone'), el('span', 'tf-when', when(c.created)))
    if (isStale(writer.view.state, c)) {
      const s = el('span', 'tf-stale', 'text changed')
      s.title = `Was: “${c.quote}”`
      meta.appendChild(s)
    }
    card.appendChild(meta)

    if (c.quote) card.appendChild(el('blockquote', 'tf-quote', c.quote))
    card.appendChild(el('p', 'tf-card-body', c.body))

    for (const [, r] of replies) {
      const rp = el('div', 'tf-reply')
      rp.append(
        el('span', 'tf-who', rs.review.people[r.author]?.name ?? 'Someone'),
        el('p', 'tf-card-body', r.body),
      )
      card.appendChild(rp)
    }

    const foot = el('div', 'tf-card-foot')
    const reply = el('button', 'tf-link', 'Reply')
    reply.addEventListener('click', (e) => {
      e.stopPropagation()
      const text = window.prompt('Reply:')
      if (!text?.trim()) return
      const tr = addComment(writer.view.state, host.author(), text.trim(), id)
      if (tr) writer.view.dispatch(tr)
    })
    const done = el('button', 'tf-link', 'Resolve')
    done.addEventListener('click', (e) => {
      e.stopPropagation()
      const tr = resolveComment(writer.view.state, id)
      if (tr) writer.view.dispatch(tr)
    })
    foot.append(reply, done)
    card.appendChild(foot)

    card.addEventListener('click', () => focusAnnotation(id, c.from))
    return card
  }

  function suggestionCard(id: string, s: Suggestion): HTMLElement {
    const rs = writer.reviewState
    const card = el('article', 'tf-card tf-card-sug')
    if (rs.active === id) card.classList.add('is-active')
    const person = rs.review.people[s.author]
    card.style.setProperty('--tf-annot', person?.color ?? '#666')

    const meta = el('header', 'tf-card-head')
    meta.append(
      el('span', 'tf-who', person?.name ?? 'Someone'),
      el('span', 'tf-kind', s.kind),
      el('span', 'tf-when', when(s.created)),
    )
    const stale = isStale(writer.view.state, s)
    if (stale) {
      const w = el('span', 'tf-stale', 'text changed')
      w.title = `Was: “${s.quote}”`
      meta.appendChild(w)
    }
    card.appendChild(meta)

    if (s.kind !== 'insert' && s.quote) card.appendChild(el('del', 'tf-quote', s.quote))
    if (s.kind !== 'delete' && s.text) card.appendChild(el('ins', 'tf-quote tf-quote-ins', s.text))

    const foot = el('div', 'tf-card-foot')
    const yes = el('button', 'tf-link', 'Accept')
    yes.disabled = stale
    if (stale) yes.title = 'The text this applies to has changed — reject it and re-propose.'
    yes.addEventListener('click', (e) => {
      e.stopPropagation()
      const res = acceptSuggestion(writer.view.state, id)
      if (res.ok) writer.view.dispatch(res.tr)
      else host.note(`Cannot accept: ${res.reason}`, true)
    })
    const no = el('button', 'tf-link', 'Reject')
    no.addEventListener('click', (e) => {
      e.stopPropagation()
      const res = rejectSuggestion(writer.view.state, id)
      if (res.ok) writer.view.dispatch(res.tr)
    })
    foot.append(yes, no)
    card.appendChild(foot)

    card.addEventListener('click', () => focusAnnotation(id, s.from))
    return card
  }

  function render(): void {
    const rs = writer.reviewState
    list.textContent = ''
    const open = threads(rs.review)
    const sugs = Object.entries(rs.review.suggestions)
      .filter(([, s]) => s.status === 'open')
      .sort((a, b) => a[1].from - b[1].from)

    const total = open.length + sugs.length
    count.textContent = total ? String(total) : ''

    if (!total) {
      list.appendChild(
        el('p', 'tf-rail-empty', 'No open comments or suggestions. Select some text and add one below.'),
      )
    }
    for (const { root: [id, c], replies } of open) list.appendChild(commentCard(id, c, replies))
    for (const [id, s] of sugs) list.appendChild(suggestionCard(id, s))
  }

  return {
    root,
    render,
    toggle: () => {
      const on = root.classList.toggle('is-open')
      if (on) render()
      return on
    },
  }
}
