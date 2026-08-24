// SPDX-License-Identifier: MIT
// Mermaid source belongs to the document. Rendered SVG belongs to the view.

import mermaid from 'mermaid'
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'

let renderNumber = 0
let initialized = false

function initialize(): void {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'neutral',
    flowchart: { htmlLabels: false, useMaxWidth: true },
  })
  initialized = true
}

/** Reject active or external content before an SVG enters the document view. */
export function sanitizeMermaidSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') {
    throw new Error('Mermaid returned invalid SVG.')
  }

  parsed.querySelectorAll('script, iframe, object, embed, foreignObject').forEach((node) => node.remove())
  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) element.removeAttribute(attribute.name)
      if ((name === 'href' || name === 'xlink:href' || name === 'src') && !value.startsWith('#')) {
        element.removeAttribute(attribute.name)
      }
      if (name === 'style' && /url\((?!["']?#)/i.test(value)) element.removeAttribute(attribute.name)
    }
  }
  for (const style of Array.from(parsed.querySelectorAll('style'))) {
    if (/@import|url\((?!["']?#)/i.test(style.textContent ?? '')) style.remove()
  }
  return new XMLSerializer().serializeToString(parsed.documentElement)
}

async function renderSource(source: string): Promise<string> {
  initialize()
  const id = `tf-mermaid-${++renderNumber}`
  const { svg } = await mermaid.render(id, source)
  return sanitizeMermaidSvg(svg)
}

function buildFigure(source: string): {
  figure: HTMLElement
  output: HTMLElement
  sourceBlock: HTMLElement
  error: HTMLElement
} {
  const figure = document.createElement('figure')
  figure.className = 'tf-mermaid'
  figure.dataset.mermaidDiagram = 'true'
  figure.contentEditable = 'false'

  const output = document.createElement('div')
  output.className = 'tf-mermaid-render'
  output.setAttribute('aria-label', 'Mermaid diagram')

  const sourceBlock = document.createElement('pre')
  sourceBlock.className = 'tf-mermaid-source'
  sourceBlock.textContent = source

  const error = document.createElement('p')
  error.className = 'tf-mermaid-error'
  error.setAttribute('role', 'alert')

  figure.append(output, sourceBlock, error)
  return { figure, output, sourceBlock, error }
}

async function renderFigure(
  figure: HTMLElement,
  output: HTMLElement,
  sourceBlock: HTMLElement,
  error: HTMLElement,
  source: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  figure.classList.add('is-rendering')
  figure.classList.remove('is-rendered', 'has-error')
  output.replaceChildren()
  error.textContent = ''
  sourceBlock.textContent = source

  try {
    const svg = await renderSource(source)
    if (!isCurrent()) return
    output.innerHTML = svg
    figure.classList.add('is-rendered')
  } catch (cause) {
    if (!isCurrent()) return
    figure.classList.add('has-error')
    error.textContent = `Tiffin cannot render this Mermaid diagram. ${(cause as Error).message}`
  } finally {
    if (isCurrent()) figure.classList.remove('is-rendering')
  }
}

export class MermaidNodeView implements NodeView {
  readonly dom: HTMLElement
  private output: HTMLElement
  private sourceBlock: HTMLElement
  private error: HTMLElement
  private source: string
  private generation = 0

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private onGeometryChange: () => void,
    private onEdit: () => void,
  ) {
    this.source = String(node.attrs.source)
    const parts = buildFigure(this.source)
    this.dom = parts.figure
    this.output = parts.output
    this.sourceBlock = parts.sourceBlock
    this.error = parts.error
    this.dom.title = 'Double-click to edit the Mermaid source.'
    this.dom.addEventListener('dblclick', this.edit)
    void this.render()
  }

  private edit = (): void => {
    const pos = this.getPos()
    if (typeof pos === 'number') {
      const selection = this.view.state.selection
      if (!(selection instanceof NodeSelection) || selection.from !== pos) {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      }
    }
    this.onEdit()
  }

  private async render(): Promise<void> {
    const generation = ++this.generation
    await renderFigure(
      this.dom,
      this.output,
      this.sourceBlock,
      this.error,
      this.source,
      () => generation === this.generation,
    )
    if (generation === this.generation) this.onGeometryChange()
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'mermaid_diagram') return false
    const source = String(node.attrs.source)
    if (source !== this.source) {
      this.source = source
      void this.render()
    }
    return true
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.generation++
    this.dom.removeEventListener('dblclick', this.edit)
  }
}

/** Render all schema-produced Mermaid figures in a static document copy. */
export async function renderStaticMermaid(root: ParentNode): Promise<void> {
  for (const figure of Array.from(root.querySelectorAll<HTMLElement>('figure[data-mermaid-diagram]'))) {
    const sourceBlock = figure.querySelector<HTMLElement>('.tf-mermaid-source')
    if (!sourceBlock) continue
    const output = document.createElement('div')
    output.className = 'tf-mermaid-render'
    output.setAttribute('aria-label', 'Mermaid diagram')
    const error = document.createElement('p')
    error.className = 'tf-mermaid-error'
    error.setAttribute('role', 'alert')
    figure.prepend(output)
    figure.append(error)
    await renderFigure(figure, output, sourceBlock, error, sourceBlock.textContent ?? '')
  }
}
