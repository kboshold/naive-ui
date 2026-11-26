// Builds the report from the collected results and decides pass or fail.
// usage: node report.mjs summary <out>   tag and own props per typed component
//        node report.mjs report <out>    report.md, exit code 1 on any failure
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, out] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const read = file => JSON.parse(readFileSync(file, 'utf8'))

function load(env) {
  const folder = path.join(out, `runtime-${env}`)
  const files = readdirSync(folder).filter(f => f.endsWith('.json')).sort()
  return Object.fromEntries(
    files.map(f => read(path.join(folder, f))).map(d => [d.name, d])
  )
}

const envs = readdirSync(out)
  .filter(f => f.startsWith('runtime-'))
  .map(f => f.slice('runtime-'.length))
  .filter(env => env !== 'jsdom')
  .sort()
if (!existsSync(path.join(out, 'runtime-jsdom'))) {
  console.error('no jsdom results, run the jsdom stage first')
  process.exit(2)
}
envs.unshift('jsdom')
const runs = Object.fromEntries(envs.map(env => [env, load(env)]))
const jsdom = runs.jsdom

if (mode === 'summary') {
  const summary = {}
  for (const [name, d] of Object.entries(jsdom)) {
    if (d.typed)
      summary[name] = { tag: d.tag, own: d.own }
  }
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1))
  process.exit(0)
}

const keys = read(path.join(out, 'keys.json'))
const types = read(path.join(out, 'types.json'))
const exceptions = read(path.join(here, 'exceptions.json'))
const templateMap = read(path.join(out, 'template-map.json'))
const templateLog = readFileSync(path.join(out, 'template.log'), 'utf8')
const canaryLine = Object.entries(templateMap).find(([, row]) => row.kind === 'canary')?.[0]
const templateLines = templateLog.split('\n').filter(l => l.trim())
const canary = templateLines.filter(
  l => l.includes(`Proof.vue(${canaryLine},`) && l.includes('error TS')
)
const templateErrors = templateLines.filter(l => !canary.includes(l))
const templateAttrs = Object.values(templateMap).reduce(
  (sum, row) => sum + (row.count ?? 0),
  0
)

const good = value => value === 'ok' || value === 'vacuous'
const delegates = value => value.startsWith('delegated')
// Whether an attr leaves a trace on a native element can differ per engine
// (Firefox keeps innerHTML on <hr>), so both good results count as the same
function verdicts(d) {
  return Object.entries(d.results).map(([k, v]) => [k, good(v) ? 'good' : v])
}
const list = values => values.join(', ')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sameSet = (a, b) => same([...a].sort(), [...b].sort())

// `allowed` is a text every error has to contain to be left out
function comboIssues(combo, allowed) {
  const issues = []
  if (combo.attrs.length)
    issues.push(`attrs differ: ${list(combo.attrs)}`)
  if (combo.listeners.length)
    issues.push(`listeners lost: ${list(combo.listeners)}`)
  const later = combo.afterHover.filter(k => !combo.listeners.includes(k))
  if (later.length)
    issues.push(`listeners lost after hover: ${list(later)}`)
  const errors = combo.errors.filter(e => !allowed || !e.includes(allowed))
  if (errors.length)
    issues.push(`errors: ${errors.map(e => e.slice(0, 80)).join('; ')}`)
  return issues
}

function variantRows(d, tagProps) {
  const reference = d.variants.default
  const known = comboIssues(reference)
  const rows = []
  for (const [label, variant] of Object.entries(d.variants)) {
    if (label === 'default' || /^(?:tag|as)=/.test(label) !== tagProps)
      continue
    if (!variant.found) {
      rows.push(`\`${label}\`: not forwarded`)
      continue
    }
    const notes = []
    if (!tagProps && variant.tag !== reference.tag)
      notes.push(`lands on \`${variant.tag}\``)
    notes.push(...comboIssues(variant).filter(i => !known.includes(i)))
    if (notes.length)
      rows.push(`\`${label}\`: ${notes.join('; ')}`)
  }
  return rows
}

function stats(run) {
  const typed = Object.values(run).filter(d => d.typed)
  const values = typed.flatMap(d => Object.values(d.results))
  const deviations = []
  const delegated = {}
  for (const d of typed) {
    for (const [key, value] of Object.entries(d.results)) {
      if (delegates(value))
        (delegated[d.name] ??= []).push(key)
      else if (!good(value))
        deviations.push(`\`${d.name}\` \`${key}\`: ${value}`)
    }
  }
  const combos = {}
  for (const d of typed) {
    const issues = comboIssues(d.variants.default)
    if (issues.length)
      combos[d.name] = issues
  }
  return {
    typed,
    untyped: Object.values(run).filter(d => !d.typed),
    checks: values.length,
    ok: values.filter(v => v === 'ok').length,
    vacuous: values.filter(v => v === 'vacuous').length,
    deviations,
    delegated,
    combos
  }
}

const failures = []
const lines = []
const print = (line = '') => lines.push(line)
const names = Object.keys(keys.components)
const all = Object.fromEntries(envs.map(env => [env, stats(runs[env])]))
const main = all.jsdom

for (const env of envs) {
  const s = all[env]
  const missing = names.filter(name => !runs[env][name])
  if (missing.length)
    failures.push(`${env}: no result for ${list(missing)}`)
  for (const deviation of s.deviations)
    failures.push(`${env}: ${deviation}`)
  for (const [name, found] of Object.entries(s.delegated)) {
    const extra = found.filter(k => !(exceptions.delegated[name] ?? []).includes(k))
    if (extra.length)
      failures.push(`${env}: \`${name}\` fires ${list(extra)} on a descendant only`)
  }
  for (const d of s.typed) {
    const expected = exceptions.combination[d.name]
    const issues = comboIssues(d.variants.default, expected?.error)
    if (!same(issues, expected?.issues ?? []))
      failures.push(`${env}: \`${d.name}\` combination pass: ${issues.join('; ') || 'expected finding is gone'}`)
    if (!types[d.name])
      failures.push(`${env}: \`${d.name}\` is typed but rendered no element to compare the types with`)
  }
  for (const d of s.untyped) {
    const found = Object.values(d.results).filter(v => v !== 'no element').length
    if (d.tag || found)
      failures.push(`${env}: \`${d.name}\` is not typed but renders an element that could take attrs`)
  }
  if (env === 'jsdom')
    continue
  for (const name of names) {
    const a = jsdom[name]
    const b = runs[env][name]
    if (a && b && !(same(verdicts(a), verdicts(b)) && a.tag === b.tag))
      failures.push(`${env}: \`${name}\` differs from jsdom`)
  }
}

const typeDiff = {}
let mismatched = 0
for (const [name, t] of Object.entries(types)) {
  if (t.error) {
    failures.push(`types: \`${name}\` ${t.error}`)
    continue
  }
  mismatched += t.mismatched.length
  if (t.mismatched.length)
    failures.push(`types: \`${name}\` value type differs from Vue's for ${list(t.mismatched)}`)
  if (t.extra.length || t.missing.length)
    typeDiff[name] = t
  const expected = exceptions.keys[name] ?? {}
  if (!sameSet(t.extra, expected.extra ?? []) || !sameSet(t.missing, expected.missing ?? [])) {
    failures.push(
      `types: \`${name}\` key set differs from <${t.tag}>: typed but not on the tag [${list(t.extra)}], on the tag but not typed [${list(t.missing)}]`
    )
  }
}
for (const name of Object.keys(exceptions.keys)) {
  if (!types[name])
    failures.push(`types: \`${name}\` is listed in exceptions.json but was not checked`)
}
for (const error of templateErrors)
  failures.push(`template: ${error.trim()}`)
if (canary.length !== 1)
  failures.push('template: the canary error is missing, vue-tsc did not check the template')
if (templateAttrs !== main.checks) {
  failures.push(
    `template: uses ${templateAttrs} attrs, runtime checked ${main.checks}`
  )
}

const title = { jsdom: 'jsdom', chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }

print('# Typed native attrs vs runtime behaviour')
print()
print(`Verdict: **${failures.length ? 'FAIL' : 'PASS'}**`)
print()
print('## What is checked')
print()
print('1. **Types to keys.** Every exported component is read from the source types, and each native attr and listener its props accept is listed.')
print('2. **Runtime.** Per component and key: mount the component with only that key, find the element that got it, and render a native element of the same tag with the same key. Every attribute and DOM property the native element gets has to be on the element of the component with the same value, for two different values per attr. Listeners have to fire and must not throw.')
print('3. **Types vs native.** For the tag a component rendered, its native keys and their value types are compared with the type Vue declares for that tag. Every difference has to be listed in `exceptions.json`.')
print('4. **Template.** One template with `strictTemplates` uses every key on every component, plus one unknown attr per component that has to be rejected.')
print('5. **Combination.** All attrs and all listeners at once, listeners fired again after a hover.')
print('6. **Untyped components.** They are mounted too and must not render an element that takes the attrs.')
print()
print('The combination is also repeated per value of every boolean and string enum prop. That part is only listed (from jsdom, under "Props that change forwarding") and does not count for the verdict.')
print()
print('## Result')
print()
print(`- Components: ${names.length} exported, ${main.typed.length} typed, ${main.untyped.length} untyped.`)
print()
print('| Environment | Checks | Identical to native | No effect on native either | Fires on a descendant | Deviations |')
print('|---|---|---|---|---|---|')
for (const env of envs) {
  const s = all[env]
  const delegated = Object.values(s.delegated).flat().length
  print(`| ${title[env] ?? env} | ${s.checks} | ${s.ok} | ${s.vacuous} | ${delegated} | ${s.deviations.length} |`)
}
print()
if (envs.length > 1) {
  const differing = failures.filter(f => f.endsWith('differs from jsdom')).length
  print(`- Same verdict per key in all ${envs.length} environments: ${differing ? 'NO' : 'yes'}.`)
}
print(`- Value types differing from Vue's native type: ${mismatched}.`)
print(`- Strict template: ${templateAttrs} attrs on ${main.typed.length} components, ${templateErrors.length} errors. An unused \`@vue-expect-error\` is an error too, so the ${main.typed.length} unknown attr and ${main.untyped.length} untyped component rejections all triggered. One line without \`@vue-expect-error\` has to give exactly one error, which shows that vue-tsc checked the file: ${canary.length === 1 ? 'yes' : 'NO'}.`)
print()
print('## Failures')
print()
if (failures.length) {
  for (const failure of failures.slice(0, 200))
    print(`- ${failure}`)
  if (failures.length > 200)
    print(`- and ${failures.length - 200} more`)
}
else {
  print('None.')
}
print()
print('## Listeners that fire on a descendant')
print()
print('Expected, listed in `exceptions.json`.')
print()
for (const [name, found] of Object.entries(main.delegated))
  print(`- \`${name}\`: ${list(found)}`)
if (!Object.keys(main.delegated).length)
  print('None.')
print()
print('## Combination pass findings')
print()
print('Expected, listed in `exceptions.json`. The scroll and wheel ones are the listeners from above. The `NMention` error comes from a timer that fires after the unmount and shows up depending on timing.')
print()
for (const env of envs) {
  for (const [name, issues] of Object.entries(all[env].combos))
    print(`- ${title[env] ?? env} \`${name}\`: ${issues.join('; ')}`)
}
print()
print('## Results that did not repeat in a fresh mount')
print()
print('Timing noise. The check is repeated in a fresh mount and the second result counts.')
print()
let retried = 0
for (const env of envs) {
  for (const d of Object.values(runs[env])) {
    if (d.retried?.length) {
      retried++
      print(`- ${title[env] ?? env} \`${d.name}\`: ${d.retried.join('; ')}`)
    }
  }
}
if (!retried)
  print('None.')
print()
print('## Key set vs Vue\'s type for the rendered tag')
print()
print('| Component | Tag | Typed but not on the tag | On the tag but not typed | Why |')
print('|---|---|---|---|---|')
for (const [name, t] of Object.entries(typeDiff)) {
  const why = exceptions.keys[name]?.why ?? 'NOT EXPECTED'
  print(`| ${name} | ${t.tag} | ${list(t.extra) || '-'} | ${list(t.missing) || '-'} | ${why} |`)
}
print()
print(`The other ${Object.keys(types).length - Object.keys(typeDiff).length} typed components match the type of their tag exactly.`)
print()
print('## Props that change forwarding')
print()
print('Not failures. Types are per component, so these prop values are accepted by the type although the attrs go somewhere else or nowhere.')
print()
for (const d of main.typed) {
  const rows = variantRows(d, false)
  if (rows.length)
    print(`- \`${d.name}\`: ${rows.join('; ')}`)
}
const tagged = main.typed.filter(d =>
  Object.keys(d.variants).some(label => /^(?:tag|as)=/.test(label))
)
print(`- \`tag\` / \`as\` change the element on ${list(tagged.map(d => `\`${d.name}\``))}. Attrs and listeners still match a native element of the new tag, except:`)
let tagFindings = 0
for (const d of tagged) {
  const rows = variantRows(d, true)
  if (rows.length) {
    tagFindings++
    const more = rows.length > 8 ? ` (+${rows.length - 8} more)` : ''
    print(`  - \`${d.name}\`: ${rows.slice(0, 8).join('; ')}${more}`)
  }
}
if (!tagFindings)
  print('  - none')
print()
print('## Untyped components')
print()
print('| Component | Element | Keys that behave like native |')
print('|---|---|---|')
for (const d of main.untyped) {
  const behaving = Object.values(d.results).filter(good).length
  print(`| ${d.name} | ${d.tag ?? 'none'} | ${behaving} |`)
}
print()
print('## Per component')
print()
print('| Component | Tag | Keys checked | Identical | Own props skipped |')
print('|---|---|---|---|---|')
for (const d of main.typed) {
  const identical = Object.values(d.results).filter(good).length
  print(`| ${d.name} | ${d.tag} | ${Object.keys(d.results).length} | ${identical} | ${list(d.own) || '-'} |`)
}

writeFileSync(path.join(out, 'report.md'), `${lines.join('\n')}\n`)

console.log(`components ${names.length}, typed ${main.typed.length}, untyped ${main.untyped.length}`)
for (const env of envs) {
  const s = all[env]
  console.log(`${env}: ${s.checks} checks, ${s.ok} identical, ${s.vacuous} no effect on native, ${Object.values(s.delegated).flat().length} on a descendant, ${s.deviations.length} deviations`)
}
console.log(`strict template: ${templateAttrs} attrs, ${templateErrors.length} errors`)
console.log(`report: ${path.join(out, 'report.md')}`)
if (failures.length) {
  console.log(`FAIL, ${failures.length} failures:`)
  // One line per component and kind, the full list is in the report
  const groups = new Map()
  for (const failure of failures) {
    const group = failure.split('`').slice(0, 2).join('`')
    groups.set(group, [...(groups.get(group) ?? []), failure])
  }
  for (const [first, ...rest] of groups.values())
    console.log(`  ${first}${rest.length ? ` (+${rest.length} more)` : ''}`)
  process.exit(1)
}
console.log('PASS')
