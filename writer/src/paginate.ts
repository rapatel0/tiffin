// SPDX-License-Identifier: MIT
// The paginator. Pages are a VIEW, never a document node.
//
// WHY THIS IS A DECORATION LAYER AND NOT A SET OF NODES
// A .tiffin.html file is opened on machines we will never see: different font
// rasterization, different zoom, different browser, ten years apart. A break
// position computed here is true for THIS layout only. Writing it into the
// document would make the file lie about itself the moment it travelled — and
// travelling is the entire point of the format. So: the document stores prose
// plus the breaks a human asked for; everything else is recomputed on open.
//
// HOW MEASUREMENT STAYS HONEST
// Each top-level block is measured once, as `getBoundingClientRect().height`
// plus its computed margin-bottom. Both are POSITION-INDEPENDENT, so the bands
// this module injects cannot perturb the numbers it derived them from — no
// measure/apply/re-measure loop, no oscillation. That holds because the
// stylesheet gives blocks margin-bottom and never margin-top: no margin
// collapsing to model. Owning the CSS is what makes this arithmetic.
//
// HOW EVERY PAGE COMES OUT THE SAME HEIGHT
// A band does not merely separate pages; it ABSORBS the unused remainder of the
// page it closes. Band height = leftover + bottom margin + gap + top margin, so
// each page renders exactly `pageBox.height` regardless of how full it is. The
// first page's top margin comes from a band too, so page one is not a special
// case anywhere in this file.

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { isForcedBreak } from './schema.ts'
import { contentHeight, pageBox, runTemplate, type PageSetup, type RunningContent } from './model.ts'

export const paginationKey = new PluginKey<DecorationSet>('tiffin-pagination')

interface Block {
  pos: number
  size: number
  height: number
  forced: boolean
}

/** One page's worth of computed layout. */
interface Layout {
  /** Block index that starts each page after the first. */
  breaks: number[]
  /** Unused vertical space on each page, in order. */
  fills: number[]
  pages: number
}

/** Measure every top-level block. Heights only — positions come from the doc. */
function measure(view: EditorView): Block[] {
  const blocks: Block[] = []
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset)
    let height = 0
    if (dom instanceof HTMLElement) {
      const cs = getComputedStyle(dom)
      height = dom.getBoundingClientRect().height + (parseFloat(cs.marginBottom) || 0)
      if (import.meta.env.DEV) auditMargins(dom, cs)
    }
    blocks.push({ pos: offset, size: node.nodeSize, height, forced: isForcedBreak(node.type.name) })
  })
  return blocks
}

/**
 * Dev-only enforcement of the stylesheet's measurement contract.
 *
 * A margin-top on a top-level block collapses with the previous block's
 * margin-bottom, so the sum of the heights this module measures stops matching
 * the height the browser actually lays out. It is a few pixels, it is silent,
 * and it accumulates down a long document until a page breaks a line early.
 * Documenting the rule in styles.css was not enough — a comment does not fail a
 * build, so this does. Tree-shaken out of the shipped shell.
 */
function auditMargins(dom: HTMLElement, cs: CSSStyleDeclaration): void {
  const top = parseFloat(cs.marginTop) || 0
  if (top !== 0) {
    console.error(
      `tiffin: <${dom.tagName.toLowerCase()}> has margin-top: ${cs.marginTop}. Top-level blocks must use ` +
        `margin-bottom only — see THE MEASUREMENT CONTRACT in styles.css. Pagination will drift.`,
    )
  }
}

/**
 * Walk the measured blocks and decide where pages end. Pure arithmetic over the
 * heights — no DOM, so it is trivially testable and cannot depend on the
 * decorations it is about to produce.
 */
export function computeLayout(blocks: Block[], available: number): Layout {
  const breaks: number[] = []
  const fills: number[] = []
  let used = 0
  let forced = false

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]

    // A forced break consumes no height; it just means "next block, new page".
    if (b.forced) {
      forced = true
      continue
    }

    const overflows = used > 0 && used + b.height > available
    if ((forced && used > 0) || overflows) {
      breaks.push(i)
      // Clamped: a block taller than a whole page overflows its page rather
      // than producing a negative spacer. Honest overflow — see docs/VISION.md
      // "what v1 is not".
      fills.push(Math.max(0, available - used))
      used = 0
    }
    forced = false
    used += b.height
  }

  fills.push(Math.max(0, available - used))
  return { breaks, fills, pages: breaks.length + 1 }
}

/** One running-content row (header or footer band), laid out left/center/right. */
function runRow(rc: RunningContent, page: number, pages: number, setup: PageSetup, height: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tf-run'
  row.style.height = `${height}px`
  row.style.paddingLeft = `${setup.margin.left}px`
  row.style.paddingRight = `${setup.margin.right}px`
  for (const slot of ['left', 'center', 'right'] as const) {
    const cell = document.createElement('span')
    cell.className = `tf-run-${slot}`
    cell.textContent = runTemplate(rc[slot], page, pages)
    row.appendChild(cell)
  }
  return row
}

type BandKind = 'top' | 'mid' | 'bottom'

/**
 * Build a band. Bands are chrome, not content: contenteditable=false, and they
 * are pulled out to the full page width with negative margins so the gray gap
 * reads as space BETWEEN two page cards rather than a stripe inside one.
 */
function band(kind: BandKind, page: number, pages: number, fill: number, setup: PageSetup): HTMLElement {
  const el = document.createElement('div')
  el.className = `tf-band tf-band-${kind}`
  el.contentEditable = 'false'
  el.style.marginLeft = `-${setup.margin.left}px`
  el.style.marginRight = `-${setup.margin.right}px`
  el.style.width = `${pageBox(setup).width}px`

  if (kind !== 'top') {
    const spacer = document.createElement('div')
    spacer.className = 'tf-fill'
    spacer.style.height = `${fill}px`
    el.appendChild(spacer)
    el.appendChild(runRow(setup.footer, page, pages, setup, setup.margin.bottom))
  }
  if (kind === 'mid') {
    const gap = document.createElement('div')
    gap.className = 'tf-gap'
    gap.style.height = `${setup.gap}px`
    el.appendChild(gap)
  }
  if (kind !== 'bottom') {
    el.appendChild(runRow(setup.header, kind === 'top' ? 1 : page + 1, pages, setup, setup.margin.top))
  }
  return el
}

function buildDecorations(view: EditorView, blocks: Block[], layout: Layout, setup: PageSetup): Decoration[] {
  const { pages } = layout
  const decos: Decoration[] = [
    Decoration.widget(0, () => band('top', 1, pages, 0, setup), {
      side: -1,
      key: `tf-top:${pages}`,
      ignoreSelection: true,
    }),
  ]

  layout.breaks.forEach((blockIndex, n) => {
    const b = blocks[blockIndex]
    const pageClosing = n + 1
    const fill = layout.fills[n]
    decos.push(
      Decoration.widget(b.pos, () => band('mid', pageClosing, pages, fill, setup), {
        side: -1,
        key: `tf-mid:${pageClosing}:${pages}:${Math.round(fill)}`,
        ignoreSelection: true,
      }),
      // The same break position, handed to the print engine. This is what makes
      // paper agree with the screen instead of being a second opinion.
      Decoration.node(b.pos, b.pos + b.size, { class: 'tf-break-before' }),
    )
  })

  const lastFill = layout.fills[layout.fills.length - 1]
  decos.push(
    Decoration.widget(view.state.doc.content.size, () => band('bottom', pages, pages, lastFill, setup), {
      side: 1,
      key: `tf-bot:${pages}:${Math.round(lastFill)}`,
      ignoreSelection: true,
    }),
  )
  return decos
}

export interface PaginationHost {
  setup(): PageSetup
  onPages?(pages: number): void
}

/**
 * rAF-coalesced repagination.
 *
 * The signature check is what keeps this from spinning: applying decorations
 * dispatches a transaction, which calls update(), which schedules another pass.
 * That pass measures the same layout, produces the same signature, and stops.
 * Without it the editor would repaginate forever at 60 fps.
 */
class Paginator {
  private pending = false
  private frame = 0
  private timer = 0
  private retries = 0
  private signature = ''
  private observer: ResizeObserver | null = null
  private destroyed = false

  constructor(
    private view: EditorView,
    private host: PaginationHost,
  ) {
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.schedule())
      this.observer.observe(view.dom)
    }
    // Belt and braces: system fonts mean no FOUT, but a document that embeds a
    // font would otherwise paginate against the fallback metrics.
    void document.fonts?.ready.then(() => this.schedule())
  }

  /**
   * Coalesce to the next frame — but RACE rAF against a timer, first one wins.
   *
   * rAF alone is wrong here, and it fails silently. A context that produces no
   * compositor frames never calls the callback at all: headless rendering, a
   * tab that loads in the background, a hidden iframe opened only to print.
   * Those are exactly the contexts a document format has to survive, and the
   * failure mode is the worst kind — the document renders fine as ONE enormous
   * page, so nothing looks broken until the PDF comes out wrong.
   */
  schedule(): void {
    if (this.destroyed || this.pending) return
    this.pending = true
    const fire = () => {
      if (!this.pending) return
      this.pending = false
      cancelAnimationFrame(this.frame)
      clearTimeout(this.timer)
      this.frame = 0
      this.timer = 0
      this.run()
    }
    this.frame = requestAnimationFrame(fire)
    this.timer = window.setTimeout(fire, 32)
  }

  /** Force a fresh pass even if the layout signature has not changed. */
  invalidate(): void {
    this.signature = ''
    this.schedule()
  }

  private run(): void {
    if (this.destroyed) return
    if (!this.view.dom.isConnected) {
      // Mounted-but-not-yet-attached is a legitimate transient state (the app
      // builds the view before re-homing it into the page column). Retry rather
      // than give up permanently, but bounded: a view that is detached for good
      // must not spin forever.
      if (this.retries++ < 100) this.schedule()
      return
    }
    this.retries = 0
    const setup = this.host.setup()
    const blocks = measure(this.view)
    const layout = computeLayout(blocks, contentHeight(setup))

    const signature = JSON.stringify([
      setup,
      layout.breaks,
      layout.fills.map((f) => Math.round(f)),
      blocks.length,
    ])
    if (signature === this.signature) return
    this.signature = signature

    const decos = buildDecorations(this.view, blocks, layout, setup)
    this.host.onPages?.(layout.pages)
    this.view.dispatch(
      this.view.state.tr.setMeta(paginationKey, DecorationSet.create(this.view.state.doc, decos)).setMeta('addToHistory', false),
    )
  }

  destroy(): void {
    this.destroyed = true
    this.pending = false
    cancelAnimationFrame(this.frame)
    clearTimeout(this.timer)
    this.observer?.disconnect()
  }
}

let active: Paginator | null = null

/** Repaginate now — call after anything that changes geometry (page size, zoom). */
export function invalidatePagination(): void {
  active?.invalidate()
}

export function paginationPlugin(host: PaginationHost): Plugin {
  return new Plugin<DecorationSet>({
    key: paginationKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => {
        const fresh = tr.getMeta(paginationKey) as DecorationSet | undefined
        if (fresh) return fresh
        // Map through the change so bands stay put until the next rAF pass
        // replaces them. Without this, every keystroke would flash the pages
        // out of existence for a frame.
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state),
    },
    view: (view) => {
      const paginator = new Paginator(view, host)
      active = paginator
      paginator.schedule()
      return {
        update: () => paginator.schedule(),
        destroy: () => {
          paginator.destroy()
          if (active === paginator) active = null
        },
      }
    },
  })
}
