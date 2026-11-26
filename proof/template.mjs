// Generates a strict template that uses every native attr of every component once.
// usage: node template.mjs <keys.json> <runtime-summary.json> <out.vue> <map.json>
import { readFileSync, writeFileSync } from 'node:fs'

const [keysPath, runtimePath, outPath, mapPath] = process.argv.slice(2)
const { components } = JSON.parse(readFileSync(keysPath, 'utf8'))
const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
const required = { NTab: 'name="n"', NTabPane: 'name="n"', NVirtualList: ':item-size="1"' }
const hyphenate = value => value.replace(/\B([A-Z])/g, '-$1').toLowerCase()

const names = Object.keys(components).sort()
const lines = [
  '<script setup lang="ts">',
  `import { ${names.join(', ')} } from 'naive-ui'`,
  '',
  'function on(..._args: unknown[]): void {}',
  '</script>',
  '',
  '<template>'
]
const map = {}
let attrs = 0
for (const name of names) {
  const run = runtime[name]
  const base = required[name] ? ` ${required[name]}` : ''
  if (!run) {
    lines.push('  <!-- @vue-expect-error -->')
    map[lines.length + 1] = { name, kind: 'untyped rejects id' }
    lines.push(`  <${name}${base} id="proof" />`)
    continue
  }
  const own = new Set(run.own)
  const parts = []
  for (const [key, info] of Object.entries(components[name].keys)) {
    if (own.has(key) || key === 'class' || key === 'style')
      continue
    attrs++
    if (info.listener)
      parts.push(`@${hyphenate(key.slice(2))}="on"`)
    else if (typeof info.value === 'string')
      parts.push(`${key}="${info.value}"`)
    else
      parts.push(`:${key}="${info.value}"`)
  }
  map[lines.length + 1] = { name, kind: 'accepts all', count: parts.length }
  lines.push(`  <${name}${base} ${parts.join(' ')} />`)
  lines.push('  <!-- @vue-expect-error -->')
  map[lines.length + 1] = { name, kind: 'rejects unknown' }
  lines.push(`  <${name}${base} proof-unknown="x" />`)
}
// No expect-error here: this line has to be the one error of the run, which
// shows that vue-tsc really checked the file
map[lines.length + 1] = { name: 'NButton', kind: 'canary' }
lines.push('  <NButton proof-canary="x" />')
lines.push('</template>', '')
writeFileSync(outPath, lines.join('\n'))
writeFileSync(mapPath, JSON.stringify(map, null, 1))
console.log(`components ${names.length}, attrs ${attrs}`)
