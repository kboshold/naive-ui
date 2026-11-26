// Reads the component types from the source and lists, per component, every
// native attr it accepts.
// usage (cwd = repo root): node types.mjs keys <out.json>
//                          node types.mjs verify <keys.json> <summary.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(`${process.cwd()}/`)
const ts = require('typescript')

const [mode, ...args] = process.argv.slice(2)
const entry = path.resolve('src/__proof__/entry.ts')
const configPath = path.resolve('tsconfig.json')
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  process.cwd()
)
const program = ts.createProgram([entry], {
  ...config.options,
  composite: false,
  declaration: false,
  noEmit: true
})
const checker = program.getTypeChecker()
const source = program.getSourceFile(entry)

function aliasType(name) {
  const node = source.statements.find(
    s => ts.isTypeAliasDeclaration(s) && s.name.text === name
  )
  return checker.getTypeFromTypeNode(node.type)
}

function props(type) {
  return new Map(checker.getPropertiesOfType(type).map(s => [s.name, s]))
}

const elements = props(aliasType('Elements'))
const elementProps = new Map(
  [...elements].map(([tag, symbol]) => [
    tag,
    props(checker.getTypeOfSymbol(symbol))
  ])
)
const universe = new Set()
for (const map of elementProps.values()) {
  for (const key of map.keys()) universe.add(key)
}

const componentProps = new Map()
for (const [name, symbol] of props(aliasType('Components'))) {
  if (!/^N[A-Z]/.test(name))
    continue
  const signatures = checker
    .getTypeOfSymbol(symbol)
    .getConstructSignatures()
  const instance = signatures[0]?.getReturnType()
  const propsSymbol = instance?.getProperty('$props')
  componentProps.set(
    name,
    propsSymbol ? props(checker.getTypeOfSymbol(propsSymbol)) : null
  )
}

// Sorted, because the order of union members is not stable between TS versions
function members(type) {
  const all = type.isUnion() ? [...type.types] : [type]
  const rank = t => (t.isLiteral() ? `${typeof t.value} ${t.value}` : '')
  return all.sort((a, b) => rank(a).localeCompare(rank(b)))
}

// A value the type accepts, preferring one that leaves a visible trace on the element
function sample(type) {
  if (type.flags & ts.TypeFlags.Any)
    return 'proof'
  const all = members(type)
  const literal = all.find(t => t.isStringLiteral() && t.value !== '')
  if (literal)
    return literal.value
  if (all.some(t => t.flags & ts.TypeFlags.String))
    return 'proof'
  const number = all.find(t => t.isNumberLiteral())
  if (number)
    return number.value
  if (all.some(t => t.flags & ts.TypeFlags.Number))
    return 1
  if (all.some(t => t.flags & ts.TypeFlags.BooleanLiteral))
    return true
  return null
}

// A second, different value, to catch attrs a component overwrites with the first one
function alternative(type, first) {
  if (type.flags & ts.TypeFlags.Any)
    return 'proof-2'
  const all = members(type)
  const literal = all.find(
    t => t.isStringLiteral() && t.value !== '' && t.value !== first
  )
  if (literal)
    return literal.value
  if (all.some(t => t.flags & ts.TypeFlags.String))
    return 'proof-2'
  const number = all.find(t => t.isNumberLiteral() && t.value !== first)
  if (number)
    return number.value
  if (all.some(t => t.flags & ts.TypeFlags.Number))
    return 2
  if (first === true && all.some(t => t.flags & ts.TypeFlags.BooleanLiteral))
    return false
  return null
}

function identical(a, b) {
  return checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a)
}

if (mode === 'keys') {
  const result = { universe: [...universe].sort(), elements: {}, components: {} }
  for (const [tag, map] of elementProps)
    result.elements[tag] = [...map.keys()].sort()
  for (const [name, map] of componentProps) {
    if (!map) {
      result.components[name] = null
      continue
    }
    const keys = {}
    const required = []
    const variants = {}
    for (const [key, symbol] of map) {
      if (!(symbol.flags & ts.SymbolFlags.Optional))
        required.push(key)
      const options = members(checker.getTypeOfSymbol(symbol)).filter(
        t => !(t.flags & ts.TypeFlags.Undefined)
      )
      const literals = options.filter(t => t.isStringLiteral()).map(t => t.value)
      const booleans = options.some(t => t.flags & ts.TypeFlags.BooleanLiteral)
      if (literals.length || booleans)
        variants[key] = [...literals, ...(booleans ? [true, false] : [])]
      if (!universe.has(key))
        continue
      const type = checker.getTypeOfSymbol(symbol)
      const listener = /^on[A-Z]/.test(key)
      keys[key] = {
        listener,
        type: checker.typeToString(type),
        value: listener ? null : sample(type),
        alt: listener ? null : alternative(type, sample(type))
      }
    }
    result.components[name] = { keys, required, variants }
  }
  writeFileSync(args[0], JSON.stringify(result, null, 1))
  const typed = Object.values(result.components).filter(
    c => c && 'id' in c.keys
  ).length
  console.log(
    `components ${componentProps.size}, with id typed ${typed}, universe ${universe.size}`
  )
}

if (mode === 'verify') {
  // For each component: compare its native keys with Vue's own type for the rendered tag
  const runtime = JSON.parse(readFileSync(args[1], 'utf8'))
  const result = {}
  for (const [name, map] of componentProps) {
    const run = runtime[name]
    if (!map || !run?.tag)
      continue
    const native = elementProps.get(run.tag)
    if (!native) {
      result[name] = { tag: run.tag, error: 'no Vue type for tag' }
      continue
    }
    const own = new Set(run.own)
    const typed = [...map.keys()].filter(
      // class and style were typed before and are not part of the native attrs
      k => universe.has(k) && !own.has(k) && k !== 'class' && k !== 'style'
    )
    const extra = typed.filter(k => !native.has(k))
    const missing = [...native.keys()].filter(k => !map.has(k) && !own.has(k))
    const mismatched = typed.filter(
      k =>
        native.has(k)
        && !identical(
          checker.getTypeOfSymbol(map.get(k)),
          checker.getTypeOfSymbol(native.get(k))
        )
    )
    result[name] = {
      tag: run.tag,
      typed: typed.length,
      native: native.size,
      extra,
      missing,
      mismatched
    }
  }
  writeFileSync(args[2], JSON.stringify(result, null, 1))
  const dirty = Object.entries(result).filter(
    ([, r]) => r.error || r.extra.length || r.missing.length || r.mismatched.length
  )
  console.log(`verified ${Object.keys(result).length}, with differences ${dirty.length}`)
  for (const [name, r] of dirty) {
    console.log(
      name,
      r.tag,
      JSON.stringify({ extra: r.extra, missing: r.missing, mismatched: r.mismatched, error: r.error })
    )
  }
}
