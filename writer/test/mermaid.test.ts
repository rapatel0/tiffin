// SPDX-License-Identifier: MIT
// Pure document-model tests for Mermaid diagrams.

import { Node as PMNode } from 'prosemirror-model'
import { schema } from '../src/schema.ts'

let failed = 0
let ran = 0
function check(name: string, condition: boolean, detail = ''): void {
  ran++
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const source = 'flowchart LR\n  request --> policy\n  policy --> decision'
const diagram = schema.nodes.mermaid_diagram.create({ source })
const doc = schema.node('doc', null, [diagram])
doc.check()

check('Mermaid is a block node', diagram.isBlock)
check('Mermaid source stays exact', diagram.attrs.source === source)
check('document JSON stores no rendered SVG', !JSON.stringify(doc.toJSON()).includes('<svg'))

const roundTrip = PMNode.fromJSON(schema, doc.toJSON())
roundTrip.check()
check('Mermaid source survives a JSON round trip', roundTrip.firstChild?.attrs.source === source)

let rejected = false
try {
  const invalid = PMNode.fromJSON(schema, {
    type: 'doc',
    content: [{ type: 'mermaid_diagram', attrs: { source: 7 } }],
  })
  invalid.check()
} catch {
  rejected = true
}
check('non-string Mermaid source is rejected', rejected)

console.log(`\n${failed ? 'FAILED' : 'ok'} — ${ran - failed}/${ran} checks passed`)
process.exit(failed ? 1 : 0)
