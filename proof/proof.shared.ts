// Mounts every component once per native attr its type accepts and compares the
// receiving element with a native element of the same tag given the same attr.
import type { Component } from 'vue'
import { mount } from '@vue/test-utils'
import { camelize, h, nextTick, render } from 'vue'
import * as components from '../index'
import keysJson from './keys.json'

interface Key {
  listener: boolean
  type: string
  value: string | number | boolean | null
  alt: string | number | boolean | null
}

interface Entry {
  keys: Record<string, Key>
  required: string[]
  variants: Record<string, (string | boolean)[]>
}

const keysFile: { components: Record<string, Entry> } = keysJson as never
const registry: Record<string, Component> = components as never

const mountProps: Record<string, Record<string, unknown>> = {
  NBackTop: { show: true },
  NDrawer: { show: true },
  NDropdown: { show: true, x: 0, y: 0, options: [{ key: 'key' }] },
  NImagePreview: { show: true },
  NModal: { show: true, preset: 'card' },
  NPopconfirm: { show: true, x: 0, y: 0 },
  NPopover: { show: true, x: 0, y: 0 },
  NPopselect: { show: true, x: 0, y: 0 },
  NTabPane: { name: 'name', tab: 'tab' },
  NTooltip: { show: true, x: 0, y: 0 }
}

const parents: Record<string, [string, Record<string, unknown>?]> = {
  NAnchorLink: ['NAnchor'],
  NBreadcrumbItem: ['NBreadcrumb'],
  NCarouselItem: ['NCarousel'],
  NCol: ['NRow'],
  NCollapseItem: ['NCollapse'],
  NDescriptionsItem: ['NDescriptions'],
  NDrawerContent: ['NDrawer', { show: true }],
  NFormItemCol: ['NRow'],
  NFormItemGi: ['NGrid'],
  NFormItemGridItem: ['NGrid'],
  NGi: ['NGrid'],
  NGridItem: ['NGrid'],
  NListItem: ['NList'],
  NStep: ['NSteps'],
  NTab: ['NTabs', { value: 'name' }],
  NTabPane: ['NTabs', { value: 'name' }],
  NTimelineItem: ['NTimeline'],
  NUploadDragger: ['NUpload'],
  NUploadFileList: [
    'NUpload',
    {
      abstract: true,
      defaultFileList: [{ id: 'id', name: 'name', status: 'finished' }]
    }
  ],
  NUploadTrigger: ['NUpload']
}

// Firefox submits a form when a script dispatches `submit` on it, and with
// `tag="form"` that would navigate the test page away
window.addEventListener('submit', event => event.preventDefault(), true)

function emit(target: Element, type: string): void {
  target.dispatchEvent(new Event(type, { cancelable: true }))
}

function hyphenate(value: string): string {
  return value.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

function declares(component: Component, key: string): boolean {
  const options = component as { props?: unknown, emits?: unknown }
  const name = camelize(key)
  const props = Array.isArray(options.props)
    ? options.props
    : Object.keys(options.props ?? {})
  if (props.includes(name))
    return true
  if (!/^on[A-Z]/.test(key))
    return false
  const emits = Array.isArray(options.emits)
    ? options.emits
    : Object.keys(options.emits ?? {})
  return emits.map((e: string) => camelize(`on-${e}`)).includes(name)
}

interface Mounted {
  element: Element | null
  errors: string[]
  warnings: string[]
  unmount: () => void
}

async function mountWith(
  name: string,
  attrs: Record<string, unknown>,
  slot = true
): Promise<Mounted> {
  const component = registry[name]
  const [parentName, parentProps] = parents[name] ?? []
  const errors: string[] = []
  const warnings: string[] = []
  const props = { ...mountProps[name], 'data-proof': name, ...attrs }
  const slots = slot ? { default: () => h('span') } : undefined
  const onError = (event: ErrorEvent): void => {
    errors.push(`window: ${event.message}`)
    event.preventDefault()
  }
  window.addEventListener('error', onError)
  let wrapper: { unmount: () => void } | undefined
  try {
    wrapper = mount(
      () =>
        parentName
          ? h(registry[parentName], parentProps, {
              default: () => h(component, props, slots)
            })
          : h(component, props, slots),
      {
        attachTo: document.body,
        global: {
          config: {
            errorHandler: (error: unknown) => {
              errors.push(String(error))
            },
            warnHandler: (message: string) => {
              if (message.includes('Extraneous non-'))
                warnings.push(message)
            }
          }
        }
      }
    )
    await nextTick()
  }
  catch (error) {
    errors.push(`mount: ${String(error)}`)
  }
  return {
    get element() {
      return document.querySelector('[data-proof]')
    },
    errors,
    warnings,
    unmount: () => {
      try {
        wrapper?.unmount()
      }
      catch (error) {
        errors.push(`unmount: ${String(error)}`)
      }
      window.removeEventListener('error', onError)
      document.body.innerHTML = ''
    }
  }
}

function nativeElement(tag: string, props: Record<string, unknown>): Element {
  const container = document.createElement('div')
  render(h(tag, props), container)
  const element = container.firstElementChild
  if (!element)
    throw new Error(`no native ${tag}`)
  return element
}

function primitive(value: unknown): boolean {
  return value === null || typeof value !== 'object'
}

async function checkAttr(
  name: string,
  key: string,
  value: unknown
): Promise<string> {
  const mounted = await mountWith(name, { [key]: value })
  try {
    const element = mounted.element
    if (mounted.errors.length)
      return `error: ${mounted.errors[0]}`
    if (!element)
      return 'no element'
    const tag = element.tagName.toLowerCase()
    const native = nativeElement(tag, { [key]: value })
    const pristine = nativeElement(tag, {})
    let traces = 0
    for (const attr of Array.from(native.attributes)) {
      traces++
      if (element.getAttribute(attr.name) !== attr.value) {
        return `attribute ${attr.name}: native "${attr.value}", component "${element.getAttribute(attr.name)}"`
      }
    }
    const nativeProp: unknown = Reflect.get(native, key)
    if (key in native && primitive(nativeProp)) {
      if (nativeProp !== Reflect.get(pristine, key))
        traces++
      const actual: unknown = Reflect.get(element, key)
      if (actual !== nativeProp) {
        return `property ${key}: native ${JSON.stringify(nativeProp)}, component ${JSON.stringify(actual)}`
      }
    }
    if (mounted.warnings.length)
      return `warning: ${mounted.warnings[0]}`
    return traces ? 'ok' : 'vacuous'
  }
  finally {
    mounted.unmount()
  }
}

async function fire(
  name: string,
  key: string,
  withListener: boolean
): Promise<{
  called: number
  delegated: number
  errors: string[]
  found: boolean
}> {
  const handler = vi.fn()
  const event = hyphenate(key.slice(2))
  const mounted = await mountWith(name, withListener ? { [key]: handler } : {})
  try {
    const element = mounted.element
    if (element)
      emit(element, event)
    await nextTick()
    const called = handler.mock.calls.length
    // Internal handlers further down may receive the same listener
    for (const node of Array.from(document.body.querySelectorAll('*'))) {
      if (node !== element && node.isConnected)
        emit(node, event)
    }
    await nextTick()
    return {
      called,
      delegated: handler.mock.calls.length - called,
      errors: [...mounted.errors],
      found: !!element
    }
  }
  finally {
    mounted.unmount()
  }
}

async function checkListener(name: string, key: string): Promise<string> {
  const event = hyphenate(key.slice(2))
  const nativeHandler = vi.fn()
  nativeElement('div', { [key]: nativeHandler }).dispatchEvent(new Event(event))
  if (nativeHandler.mock.calls.length !== 1)
    return `native control did not fire for ${event}`
  const result = await fire(name, key, true)
  if (!result.found)
    return 'no element'
  if (result.errors.length) {
    const baseline = await fire(name, key, false)
    const added = result.errors.filter(e => !baseline.errors.includes(e))
    if (added.length)
      return `error: ${added[0]}`
  }
  if (result.called === 0) {
    return result.delegated > 0
      ? 'delegated: fires on a descendant, not on the element'
      : 'listener not called'
  }
  return 'ok'
}

interface Combination {
  found: boolean
  tag: string | null
  attrs: string[]
  listeners: string[]
  afterHover: string[]
  errors: string[]
}

// All attrs and all listeners at once, listeners fired twice with a hover in between
async function combination(
  name: string,
  keys: Record<string, Key>,
  extra: Record<string, unknown>,
  slot: boolean
): Promise<Combination> {
  const component = registry[name]
  const attrs: Record<string, unknown> = {}
  const handlers: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const [key, info] of Object.entries(keys)) {
    if (
      key === 'class'
      || key === 'style'
      || key === 'innerHTML'
      || key in extra
      || declares(component, key)
    ) {
      continue
    }
    if (info.listener)
      handlers[key] = vi.fn()
    else
      attrs[key] = info.value
  }
  const mounted = await mountWith(name, { ...attrs, ...handlers, ...extra }, slot)
  try {
    const first = mounted.element
    if (!first) {
      return {
        found: false,
        tag: null,
        attrs: [],
        listeners: [],
        afterHover: [],
        errors: [...mounted.errors]
      }
    }
    const tag = first.tagName.toLowerCase()
    const native = nativeElement(tag, attrs)
    const wrong: string[] = []
    for (const attr of Array.from(native.attributes)) {
      if (first.getAttribute(attr.name) !== attr.value)
        wrong.push(attr.name)
    }
    for (const key of Object.keys(attrs)) {
      const expected: unknown = Reflect.get(native, key)
      if (
        key in native
        && primitive(expected)
        && Reflect.get(first, key) !== expected
        && !wrong.includes(key)
      ) {
        wrong.push(key)
      }
    }
    const round = async (): Promise<string[]> => {
      const lost: string[] = []
      for (const [key, handler] of Object.entries(handlers)) {
        const before = handler.mock.calls.length
        if (mounted.element)
          emit(mounted.element, hyphenate(key.slice(2)))
        await nextTick()
        if (handler.mock.calls.length === before)
          lost.push(key)
      }
      return lost
    }
    // Vue ignores events fired in the millisecond a listener was attached
    await new Promise(resolve => setTimeout(resolve, 5))
    const listeners = await round()
    mounted.element?.dispatchEvent(new MouseEvent('mouseenter'))
    mounted.element?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await nextTick()
    const afterHover = await round()
    let errors = [...new Set(mounted.errors)]
    if (errors.length) {
      mounted.unmount()
      const baseline = await syntheticErrors(name, Object.keys(handlers), extra, slot)
      errors = errors.filter(error => !baseline.includes(error))
    }
    return { found: true, tag, attrs: wrong, listeners, afterHover, errors }
  }
  finally {
    mounted.unmount()
  }
}

// Errors the synthetic events cause without any native attr or listener passed
async function syntheticErrors(
  name: string,
  listeners: string[],
  extra: Record<string, unknown>,
  slot: boolean
): Promise<string[]> {
  const mounted = await mountWith(name, extra, slot)
  try {
    for (let round = 0; round < 2; round++) {
      for (const key of listeners) {
        if (mounted.element)
          emit(mounted.element, hyphenate(key.slice(2)))
        await nextTick()
      }
      mounted.element?.dispatchEvent(new MouseEvent('mouseenter'))
      mounted.element?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true })
      )
      await nextTick()
    }
    return [...mounted.errors]
  }
  finally {
    mounted.unmount()
  }
}

// String props without an enum type that change the rendered element
const extraVariants: Record<string, Record<string, string[]>> = {
  NConfigProvider: { tag: ['span'] },
  NEl: { tag: ['span', 'a'] },
  NElement: { tag: ['span', 'a'] },
  NText: { tag: ['p'], as: ['p'] }
}

// Props a variant needs to render at all
const variantProps: Record<string, Record<string, unknown>> = {
  'NSlider range=true': { defaultValue: [0, 1] }
}

export function run(
  shard: number,
  shards: number,
  save: (name: string, content: string) => Promise<void> | void
): void {
  // VITE_PROOF_ONLY=NCard,NButton limits a run to some components
  const only: string | undefined = import.meta.env.VITE_PROOF_ONLY
  const names = Object.keys(keysFile.components)
    .sort()
    .filter((_, index) => index % shards === shard)
    .filter(name => !only || only.split(',').includes(name))

  describe(`proof ${shard}`, () => {
    beforeAll(() => {
      if (!globalThis.localStorage)
        vi.stubGlobal('localStorage', {})
    })

    it.each(names)('%s', async (name) => {
      const entry = keysFile.components[name]
      const component = registry[name]
      // Typed: the type accepts a native key that is not one of its own props
      const typed = Object.keys(entry.keys).some(
        key => key !== 'class' && key !== 'style' && !declares(component, key)
      )
      const own: string[] = []
      const results: Record<string, string> = {}
      const retried: string[] = []

      const base = await mountWith(name, {})
      const tag = base.element?.tagName.toLowerCase() ?? null
      const baseErrors = [...base.errors]
      base.unmount()

      // Untyped components: check the generic attrs to confirm nothing is forwarded
      const keys = typed
        ? entry.keys
        : keysFile.components.NDivider.keys

      for (const [key, info] of Object.entries(keys)) {
        if (key === 'class' || key === 'style')
          continue
        if (declares(component, key)) {
          own.push(key)
          continue
        }
        const check = async (): Promise<string> => {
          if (info.listener)
            return checkListener(name, key)
          const first = await checkAttr(name, key, info.value)
          if ((first !== 'ok' && first !== 'vacuous') || info.alt === null)
            return first
          // A second value catches attrs the component overwrites with the first
          const second = await checkAttr(name, key, info.alt)
          if (second !== 'ok' && second !== 'vacuous')
            return `value ${JSON.stringify(info.alt)}: ${second}`
          return first === 'ok' ? first : second
        }
        results[key] = await check()
        // A result that does not repeat in a fresh mount is reported as retried
        if (results[key] !== 'ok' && results[key] !== 'vacuous') {
          // Vue ignores events fired in the millisecond a listener was attached
          await new Promise(resolve => setTimeout(resolve, 5))
          const again = await check()
          if (again !== results[key]) {
            retried.push(`${key}: ${results[key]}`)
            results[key] = again
          }
        }
      }

      const variants: Record<string, Combination> = {}
      if (typed) {
        const reference = await combination(name, entry.keys, {}, true)
        const record = async (
          label: string,
          attrs: Record<string, unknown>,
          slot: boolean
        ): Promise<void> => {
          const result = await combination(
            name,
            entry.keys,
            { ...variantProps[`${name} ${label}`], ...attrs },
            slot
          )
          if (JSON.stringify(result) !== JSON.stringify(reference))
            variants[label] = result
        }
        variants.default = reference
        await record('no slot', {}, false)
        const all = { ...entry.variants, ...extraVariants[name] }
        for (const [prop, values] of Object.entries(all)) {
          if (
            !declares(component, prop)
            || prop.startsWith('internal')
            || prop in (mountProps[name] ?? {})
          ) {
            continue
          }
          for (const value of values)
            await record(`${prop}=${String(value)}`, { [prop]: value }, true)
        }
      }

      await save(
        name,
        JSON.stringify(
          { name, typed, tag, baseErrors, own, results, retried, variants },
          null,
          1
        )
      )
    }, 600_000)
  })
}
