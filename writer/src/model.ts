// SPDX-License-Identifier: MIT
// The tiffin/doc document model — the JSON that lives in the #tiffin-doc block.
//
// Two rules govern every field here, and they both come from the same place:
// the file travels.
//
//   1. PURE DATA. No functions, ever. Running headers use {page}/{pages} string
//      tokens rather than callbacks, so a document can never carry executable
//      code (see docs/VISION.md invariant 2).
//   2. NOTHING DERIVED. Automatic page breaks, page count, measured heights —
//      none of it is stored. It is all recomputed on open, because the machine
//      that opens this file has different fonts than the one that wrote it
//      (invariant 3).
//
// Lengths are CSS px at 96 dpi throughout. Print conversion is px/96*25.4 mm.

export const FORMAT = 'tiffin/doc'
export const VERSION = 1

export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

/** A named paper size in CSS px at 96 dpi (portrait). */
export interface PaperSize {
  width: number
  height: number
}

export const PAPER: Record<string, PaperSize> = {
  A4: { width: 794, height: 1123 },
  A5: { width: 559, height: 794 },
  Letter: { width: 816, height: 1056 },
  Legal: { width: 816, height: 1344 },
  Tabloid: { width: 1056, height: 1632 },
}

export type PaperName = keyof typeof PAPER

/**
 * Running header/footer content. Three slots per band, each a template string
 * where `{page}` and `{pages}` are substituted at render time. Empty string =
 * nothing in that slot.
 */
export interface RunningContent {
  left: string
  center: string
  right: string
}

/**
 * Page geometry lives at the TOP LEVEL of the document, beside `title` — not in
 * a preferences blob. It is a property of the document (this contract is A4
 * with 1-inch margins), and every consumer — paginator, print CSS, thumbnailer
 * — needs it before it can lay out a single line.
 */
export interface PageSetup {
  paper: PaperName
  orientation: 'portrait' | 'landscape'
  margin: Margins
  header: RunningContent
  footer: RunningContent
  /** Gray space drawn between page cards on screen. Screen-only; print ignores it. */
  gap: number
}

export interface TiffinDoc {
  format: typeof FORMAT
  version: number
  /** Stable uuid minted once at creation and never regenerated. */
  docId: string
  title: string
  pageSetup: PageSetup
  /** ProseMirror document JSON — the prose itself. */
  body: unknown
  /** ISO timestamp of the last save. */
  modified: string
  /** Shared blobs (data: URIs), referenced from the body as `asset:<key>`. */
  assets?: Record<string, string>
}

export function defaultPageSetup(): PageSetup {
  return {
    paper: 'A4',
    orientation: 'portrait',
    margin: { top: 96, right: 96, bottom: 96, left: 96 },
    header: { left: '', center: '', right: '' },
    footer: { left: '', center: '{page} / {pages}', right: '' },
    gap: 24,
  }
}

/** Outer page box in px, after orientation is applied. */
export function pageBox(setup: PageSetup): PaperSize {
  const paper = PAPER[setup.paper] ?? PAPER.A4
  return setup.orientation === 'landscape'
    ? { width: paper.height, height: paper.width }
    : { width: paper.width, height: paper.height }
}

/** Height available for prose on one page, once margins are taken out. */
export function contentHeight(setup: PageSetup): number {
  return pageBox(setup).height - setup.margin.top - setup.margin.bottom
}

export function contentWidth(setup: PageSetup): number {
  return pageBox(setup).width - setup.margin.left - setup.margin.right
}

/** Substitute the {page}/{pages} tokens in a running-content template. */
export function runTemplate(tpl: string, page: number, pages: number): string {
  return tpl.replace(/\{page\}/g, String(page)).replace(/\{pages\}/g, String(pages))
}

export function newDocId(): string {
  // crypto.randomUUID needs a secure context; file:// is not one in some
  // browsers, and this file's whole point is opening from a disk. Fall back.
  const c = globalThis.crypto
  if (c && 'randomUUID' in c) {
    try {
      return c.randomUUID()
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class DocError extends Error {}

/**
 * Parse and normalize a document read from a file.
 *
 * Deliberately lenient about MISSING fields (a document written by an older
 * build, or hand-authored by an agent, should open) and strict about WRONG
 * ones — a bad `format` means we are about to render someone else's file.
 *
 * Unknown top-level fields are preserved: formats are additive, and there is no
 * server to migrate anything, so a newer build's field must survive a
 * round-trip through an older one.
 */
export function parseDoc(raw: string): TiffinDoc {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new DocError(`document block is not valid JSON: ${(err as Error).message}`)
  }
  if (!json || typeof json !== 'object') throw new DocError('document is not an object')
  const d = json as Record<string, unknown>
  if (d.format !== FORMAT) throw new DocError(`unknown format ${JSON.stringify(d.format)} — expected ${FORMAT}`)
  if (typeof d.version === 'number' && d.version > VERSION) {
    console.warn(`tiffin: file is format v${d.version}, this build knows v${VERSION} — unknown fields are preserved`)
  }

  const setup = { ...defaultPageSetup(), ...((d.pageSetup as Partial<PageSetup>) ?? {}) }
  setup.margin = { ...defaultPageSetup().margin, ...(setup.margin ?? {}) }
  setup.header = { ...defaultPageSetup().header, ...(setup.header ?? {}) }
  setup.footer = { ...defaultPageSetup().footer, ...(setup.footer ?? {}) }
  if (!PAPER[setup.paper]) setup.paper = 'A4'

  return {
    ...(d as unknown as TiffinDoc),
    format: FORMAT,
    version: typeof d.version === 'number' ? d.version : VERSION,
    docId: typeof d.docId === 'string' && d.docId ? d.docId : newDocId(),
    title: typeof d.title === 'string' ? d.title : 'Untitled',
    pageSetup: setup,
    body: d.body ?? null,
    modified: typeof d.modified === 'string' ? d.modified : new Date().toISOString(),
  }
}

/**
 * The content that decides "did this actually change". Excludes `modified`,
 * which churns on every save without anyone having typed anything.
 */
export function docContentKey(doc: TiffinDoc): string {
  return JSON.stringify([doc.title, doc.pageSetup, doc.body, doc.assets ?? null])
}
