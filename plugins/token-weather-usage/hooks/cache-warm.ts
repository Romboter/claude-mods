// Cache warming for Token Weather Usage: a short poke before the prompt cache expires, and an
// optional wake after the usage limit resets. Off until /caffeine turns it on, per session.
// Ported from cache-caffeine by Luis Perez Morales (MIT, https://github.com/lperezmo/cache-caffeine)
// with its row above the prompt removed: the state shows in the cache pill (see warmState) and
// everything is driven by /caffeine. brew.ts and wake.ts are unchanged copies.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brew } from '../types'
import {
  clock,
  DEFAULT_IDLE,
  DEFAULT_MESSAGE,
  defaultEvery,
  dollars,
  equivalents,
  nextPokeAt,
  overLine,
  parseClock,
  parseDuration,
  pokeGuess,
  pokeWasCold,
  readTiming,
  readRate,
  sized,
  span,
  TTL_1H,
  TTL_5M,
  ttlByPlan,
  ttlFromCost,
  ttlFromEnv,
  writeRate,
} from './brew'
import type { Limit, Usage } from './brew'
import { blocking, DEFAULT_TIMER_WAKE, DEFAULT_WAKE, isNear, MARK, parseWake, wakeAfter } from './wake'

// The session's switch, kept by the host so a reload of the mod finds it.
const brew = atom({ plugin: 'token-weather-usage', key: 'brew' } as const, {
  isOn: false,
  until: 0,
  lastAt: 0,
  activeAt: 0,
  isAutoDeclined: false,
  isForever: false,
})

// A booked wake: when it fires, and what it waits out.
type Armed = { at: number; label: string; text: string }

// The booked wake as the store keeps it, so `--resume` finds it again.
type KeptWake = { session: string; at: number; label: string; text?: string }

type Caffeine = Brew & {
  // a main-thread turn is running; its own requests keep the cache warm
  isBusy: boolean
  // a poke submitted, then running in its own turn
  poke: 'none' | 'sent' | 'running'
  pokeTurnId: string
  sentAt: number
  pokes: number
  // what the pokes cost this session, in input-token equivalents
  spent: number
  lastPoke: Usage | null
  // whether the last poke found the cache still warm
  lastWarm: boolean | null
  limits: Limit[]
  context: number
  model: string
  // the TTL sources, in ttlOf's order: the person's override, the environment, a 1h cost
  // reading, request timing; else Claude Code's choice by plan
  ttl: number | null
  envTtl: number | null
  // only ever 1h (a 1.25x cost cannot tell 5m from 1h); cleared by a cache found cold
  // inside the hour, unless that request priced at 1h itself
  measuredTtl: number | null
  // the running turn's last request priced at 1h: its cold cache was a prefix change, not an expiry
  isPriced: boolean
  // what request timing says, for models caffeine has no price for
  timedTtl: number | null
  // what emptied the cache (compaction, /clear); pokes wait for the next request to rewrite it
  heldBy: string
  // the running poke was a first request (after a compaction or on another model),
  // so its write says nothing about the pokes before it
  isPokeExempt: boolean
  // the last time a request found the cache cold, and the gap before it
  coldAt: number
  coldGap: number
  // settings kept across sessions
  message: string
  every: number | null
  idle: number
  // turn on by itself once the context passes this many tokens; 0 is never
  autoAt: number
  // the wake
  armed: Armed | null
  // the last reply failed on the usage limit
  isHit: boolean
  // caffeine was off when the wake was booked, and comes off with it
  isWakeLit: boolean
  // the session's id, the key of what the cache pill reads
  session: string
}

const MINUTE = 60_000
// `/caffeine warm` alone
const WARM = 60 * MINUTE

// env and settings first (Claude Code reads them before picking by plan, so a cost that
// contradicts them is a misread), then a 1h-priced request, then timing, then the plan
const ttlOf = (c: Caffeine) => c.ttl ?? c.envTtl ?? c.measuredTtl ?? c.timedTtl ?? ttlByPlan(c.limits)

// Where the TTL comes from, for /caffeine status.
function ttlSource(c: Caffeine): string {
  if (c.ttl !== null) return 'set with /caffeine ttl'
  if (c.envTtl !== null) return 'from the environment'
  if (c.measuredTtl !== null) return 'measured from what requests cost'
  if (c.timedTtl !== null) return 'measured from request timing'
  if (c.limits.length) return 'the subscription default'
  return c.lastAt ? 'the API-key default' : 'a guess until the first reply shows the plan'
}
const everyOf = (c: Caffeine) => c.every ?? defaultEvery(ttlOf(c))
const ttlLabel = (ms: number) => (ms >= TTL_1H ? '1h' : '5m')

// Says how it went: a toast, and a line in the transcript that outlasts it.
function tell($: EngineInterface, text: string): void {
  $.ui.toast(`caffeine: ${text}`)
  $.ui.log(`caffeine: ${text}`)
}

async function setting<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  try {
    const value = await $.store.get(key)
    return value === undefined || value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

async function load($: EngineInterface, c: Caffeine): Promise<void> {
  c.message = await setting($, 'caffeine.message', DEFAULT_MESSAGE)
  c.every = (await setting($, 'caffeine.every', null)) as number | null
  c.idle = (await setting($, 'caffeine.idle', DEFAULT_IDLE)) || DEFAULT_IDLE
  c.ttl = (await setting($, 'caffeine.ttl', null)) as number | null
  c.autoAt = await setting($, 'caffeine.autoAt', 0)
  // merged settings, as Claude Code reads them; a failed read leaves the key unset
  let promptCacheTtl: unknown
  try {
    promptCacheTtl = (await $.settings.read()).promptCacheTtl
  } catch {
    promptCacheTtl = undefined
  }
  try {
    c.envTtl = ttlFromEnv(
      await $.env.get('FORCE_PROMPT_CACHING_5M'),
      await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      promptCacheTtl,
      await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    )
  } catch {
    c.envTtl = null
  }
}

async function keep($: EngineInterface, c: Caffeine): Promise<void> {
  const kept: Brew = { isOn: c.isOn, until: c.until, lastAt: c.lastAt, activeAt: c.activeAt, isAutoDeclined: c.isAutoDeclined, isForever: c.isForever }
  await update($, brew, () => kept).catch(() => undefined)
}

// How long caffeine stays on: to a set time, or until turned off.
function howLong(c: Caffeine, now: number): string {
  if (c.until) {
    return `until ${clock(c.until, now)} (${span(c.until - now)} left)`
  }
  return c.isForever || c.armed ? 'until you turn it off' : `until you turn it off (or ${span(c.idle).replace(' 00m', '')} idle)`
}

// One line for /caffeine status.
function describe(c: Caffeine, now: number): string {
  if (!c.isOn) {
    return 'caffeine off'
  }
  const tail = [c.pokes ? `${c.pokes} poke${c.pokes === 1 ? '' : 's'}` : '', howLong(c, now)]
    .filter(Boolean)
    .map(t => ` · ${t}`)
    .join('')
  const over = overLine(c.limits)
  if (over) {
    return `caffeine paused · ${over.label} limit ${over.percent}%${tail}`
  }
  if (c.lastAt === 0) {
    const why = c.heldBy ? `waits for your next message after the ${c.heldBy}` : 'waits for the first reply'
    return `caffeine on · ${why}${tail}`
  }
  if (c.isBusy || c.poke !== 'none') {
    return `caffeine on · cache warm${tail}`
  }
  if (now - c.lastAt >= ttlOf(c)) {
    return `caffeine on · cache went cold, waits for your next turn${tail}`
  }
  const at = nextPokeAt(c.lastAt, everyOf(c))!
  return `caffeine on · poke at ${clock(at, now)} (in ${span(at - now)})${tail}`
}

// What the cache pill shows: the state recolors its bolt, the lines join its hover card.
// Null while caffeine is off and no wake is booked (the pill keeps its own tone).
type Warm = { state: 'warm' | 'poking' | 'paused' | 'cold' | 'waiting' | 'wake'; lines: string[] }

function warmState(c: Caffeine, now: number): Warm | null {
  if (!c.isOn && !c.armed) return null
  const lines = [describe(c, now).replace(/^caffeine /, 'Caffeine ')]
  if (c.lastWarm !== null) lines.push(`The last poke found the cache ${c.lastWarm ? 'warm' : 'cold'}.`)
  if (c.armed) lines.push(`Wake: Claude continues at ${clock(c.armed.at, now)} (in ${span(c.armed.at - now)}).`)
  let state: Warm['state']
  if (!c.isOn) state = 'wake'
  else if (overLine(c.limits)) state = 'paused'
  else if (c.lastAt === 0) state = 'waiting'
  else if (c.poke !== 'none') state = 'poking'
  else if (c.isBusy) state = 'warm'
  else if (now - c.lastAt >= ttlOf(c)) state = 'cold'
  else state = 'warm'
  return { state, lines }
}

async function costNow($: EngineInterface): Promise<number | null> {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return typeof usd === 'number' ? usd : null
  } catch {
    return null
  }
}

// Redraws the band and hands the cache pill its state (token-weather-usage.mjs reads it by session).
async function refresh($: EngineInterface, c: Caffeine): Promise<void> {
  const warm = warmState(c, await $.clock.now())
  try {
    if (warm && c.session) await $.store.set(`warm:${c.session}`, warm)
    else if (c.session) await $.store.delete(`warm:${c.session}`)
  } catch {
    // the pill just keeps its own tone
  }
  $.ui.invalidate('ui.render')
}

async function switchOn($: EngineInterface, c: Caffeine, isOn: boolean, until = 0): Promise<void> {
  c.isOn = isOn
  c.until = isOn ? until : 0
  c.isWakeLit = false
  c.isForever = false
  if (isOn) {
    c.activeAt = await $.clock.now()
  } else if (c.poke === 'sent') {
    c.poke = 'none'
  }
  await keep($, c)
  await refresh($, c)
}

// Sends the poke: a prompt of its own, run once the session is idle.
function poke($: EngineInterface, c: Caffeine, now: number): void {
  c.poke = 'sent'
  c.sentAt = now
  void $.prompt.submit({ text: c.message }).catch(() => {
    c.poke = 'none'
  })
}

async function tick($: EngineInterface, c: Caffeine): Promise<void> {
  const now = await $.clock.now()
  if (c.armed && now >= c.armed.at) {
    await fire($, c, c.armed)
  }
  if (!c.isOn) {
    return
  }
  if (c.until && now >= c.until) {
    const wasWake = c.isWakeLit
    await switchOn($, c, false)
    if (!wasWake) tell($, 'wore off.')
    return
  }
  if (!c.isForever && !c.armed && now - c.activeAt >= c.idle) {
    await switchOn($, c, false)
    tell($, `turned off after ${span(c.idle)} without a turn of your own.`)
    return
  }
  if (c.poke !== 'none') {
    // a poke that never got its turn (a dialog, a closed prompt) stops blocking the rest
    if (c.poke === 'sent' && now - c.sentAt > 10 * MINUTE) c.poke = 'none'
    return
  }
  // a poke into a cold cache would only write it again
  if (c.isBusy || c.lastAt === 0 || overLine(c.limits) || now - c.lastAt >= ttlOf(c)) {
    return
  }
  const due = nextPokeAt(c.lastAt, everyOf(c))
  if (due !== null && now >= due) {
    poke($, c, now)
  }
}

async function setMessage($: EngineInterface, c: Caffeine, text: string): Promise<string> {
  c.message = text.trim() || DEFAULT_MESSAGE
  await $.store.set('caffeine.message', c.message)
  return c.message
}

// What the pokes cost against one cache rewrite.
function costLines(c: Caffeine): string[] {
  const ttl = ttlOf(c)
  const model = c.model
  if (!model || c.context === 0) {
    return ['No reply yet this session: the cost comes with the first one.']
  }
  const poked = c.lastPoke ?? pokeGuess(c.context)
  const each = equivalents(poked, model, ttl)
  const rewrite = c.context * writeRate(ttl)
  const ratio = rewrite / each
  const usd = (n: number) => {
    const d = dollars(n, model)
    return d ? `, ${d}` : ''
  }
  return [
    `Context ${sized(c.context)} tokens on ${model}, ${ttlLabel(ttl)} cache, a poke ${span(everyOf(c))} after the last request.`,
    `One poke: ${sized(each)} input-token equivalents${usd(each)}${c.lastPoke ? ' (the last one, measured)' : ` (cache read at ${readRate(model)}x)`}.`,
    `One cache rewrite: ${sized(rewrite)} (written again at ${writeRate(ttl)}x)${usd(rewrite)}.`,
    `A rewrite costs about ${Math.round(ratio)} pokes: caffeine pays off if you are back within ${span(ratio * everyOf(c))}.`,
    c.pokes ? `This session: ${c.pokes} poke${c.pokes === 1 ? '' : 's'}, ${sized(c.spent)}${usd(c.spent)}.` : '',
    'At API list prices; on a Pro or Max plan the same tokens count against your usage limits instead.',
  ].filter(Boolean)
}

// The wake: caffeine's own timer submits the wake prompt at a set time (once
// the session is idle), like a poke. Stored under the session id, so
// `--resume` picks it up again.

async function arm($: EngineInterface, c: Caffeine, at: number, label: string, text = ''): Promise<void> {
  await disarm($, c)
  c.armed = { at, label, text }
  const kept: KeptWake = { session: await sessionKey($), at, label, text }
  await $.store.set('caffeine.wake', kept).catch(() => undefined)
  // the cache stays warm until Claude picks the work back up
  if (!c.isOn) {
    await switchOn($, c, true, at)
    c.isWakeLit = true
  }
  const now = await $.clock.now()
  tell($, `Claude continues at ${clock(at, now)} (in ${span(at - now)})${label ? `, after the ${label} reset` : ''}, told: ${await wakeText($, c.armed)}. Keep this session open.`)
  await refresh($, c)
}

async function disarm($: EngineInterface, c: Caffeine): Promise<boolean> {
  const armed = c.armed
  c.armed = null
  await $.store.delete('caffeine.wake').catch(() => undefined)
  if (c.isWakeLit) {
    await switchOn($, c, false)
  }
  await refresh($, c)
  return armed !== null
}

// The session's id, which a kept wake belongs to; '' where there is none.
async function sessionKey($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

// What Claude is told: the wake's own text, else the set wake prompt, else the
// default for its kind (after a limit reset, or at a time).
async function wakeText($: EngineInterface, armed: Armed): Promise<string> {
  const mine = (await setting($, 'caffeine.wakePrompt', null)) as string | null
  return armed.text || mine || (armed.label ? DEFAULT_WAKE : DEFAULT_TIMER_WAKE)
}

// Sends the wake prompt: the wake is spent.
async function fire($: EngineInterface, c: Caffeine, armed: Armed): Promise<void> {
  c.armed = null
  c.isHit = false
  await $.store.delete('caffeine.wake').catch(() => undefined)
  await refresh($, c)
  const prompt = `${MARK} ${await wakeText($, armed)}`
  void $.prompt.submit({ text: prompt }).catch(() => undefined)
}

// After `--resume` or a mod reload, take back this session's wake if still ahead.
async function adopt($: EngineInterface, c: Caffeine): Promise<void> {
  try {
    const kept = (await $.store.get('caffeine.wake')) as KeptWake | null | undefined
    if (!kept || c.armed || kept.session !== (await sessionKey($))) {
      return
    }
    if (kept.at > (await $.clock.now())) {
      c.armed = { at: kept.at, label: kept.label, text: kept.text ?? '' }
      await refresh($, c)
    } else {
      await $.store.delete('caffeine.wake')
    }
  } catch {
    // nothing kept; nothing booked
  }
}

// Books the wake at the reset of the window in the way.
async function armAtReset($: EngineInterface, c: Caffeine): Promise<void> {
  const block = blocking(c.limits)
  if (!block) {
    tell($, 'no reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.')
    return
  }
  await arm($, c, wakeAfter(block.resetsAt), block.label)
}

const NO_RESET = 'No reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.'

async function wakeCommand($: EngineInterface, c: Caffeine, args: string): Promise<{ text: string }> {
  const [word = '', ...rest] = args.split(/\s+/)
  const arg = word.toLowerCase()
  const value = rest.join(' ').trim()
  const now = await $.clock.now()
  const flip = async (key: string, name: string, fallback: boolean) => {
    const v = value.toLowerCase()
    const next = v === 'on' ? true : v === 'off' ? false : !(await setting($, key, fallback))
    await $.store.set(key, next)
    return { text: `${name} ${next ? 'on' : 'off'}.` }
  }
  switch (arg) {
    case '': {
      if (!blocking(c.limits)) return { text: NO_RESET }
      $.clock.after(50, () => void armAtReset($, c))
      return { text: 'Booking the wake…' }
    }
    case 'off':
    case 'cancel':
      $.clock.after(50, () => void disarm($, c).then(was => tell($, was ? 'wake cancelled.' : 'no wake was booked.')))
      return { text: 'Cancelling the wake…' }
    case 'prompt': {
      if (value.toLowerCase() === 'default') {
        await $.store.delete('caffeine.wakePrompt')
        return { text: `Back to the defaults: "${DEFAULT_WAKE}" after a limit reset, "${DEFAULT_TIMER_WAKE}" at a time.` }
      }
      if (!value) {
        const mine = (await setting($, 'caffeine.wakePrompt', null)) as string | null
        return {
          text: mine
            ? `On waking Claude is told: ${mine} (prompt default goes back to the defaults)`
            : `On waking Claude is told "${DEFAULT_WAKE}" after a limit reset, "${DEFAULT_TIMER_WAKE}" at a time.`,
        }
      }
      await $.store.set('caffeine.wakePrompt', value)
      return { text: `On waking Claude will be told: ${value}${c.armed ? ' (from the next wake you book)' : ''}` }
    }
    case 'auto':
      return flip('caffeine.wakeAuto', 'Booking a wake whenever the limit hits:', false)
    default: {
      const wake = parseWake(args, now)
      if (wake === null) return { text: `Not a time I know: ${args}. Try 1 min, in 20 minutes, 14:30 or 3pm.` }
      const { at, text } = wake
      $.clock.after(50, () => void arm($, c, at, '', text))
      return { text: `Booking the wake for ${clock(at, now)} (in ${span(at - now)})${text ? `, to say: ${text}` : ''}…` }
    }
  }
}

const FOREVER = 'Yes, no end'
const KEEP_STOP = 'Keep the idle stop'

// No end, but only once confirmed: the dialog spells out the cost; with no one
// to ask, a trailing "yes" confirms.
async function forever($: EngineInterface, c: Caffeine, isSure: boolean): Promise<{ text: string }> {
  const perDay = Math.round((24 * 60 * MINUTE) / everyOf(c))
  if (!isSure) {
    let answer: string
    try {
      answer = await $.ui.ask(
        `Keep the cache warm with no end this time? Caffeine pokes ${span(everyOf(c))} after the last request until you turn it off: about ${perDay} pokes a day while you are away, each using your plan's usage. Turning it off brings the idle stop back.`,
        { header: 'caffeine', options: [FOREVER, KEEP_STOP] },
      )
    } catch {
      return { text: 'No one to ask here. /caffeine forever yes confirms it.' }
    }
    if (answer !== FOREVER) {
      return { text: `Kept: caffeine still turns itself off after ${span(c.idle)} without a turn of your own.` }
    }
  }
  if (!c.isOn || c.until) {
    await switchOn($, c, true)
  }
  c.isForever = true
  await keep($, c)
  await refresh($, c)
  return { text: `Caffeine on with no end, until you turn it off. Next time you turn it on, the ${span(c.idle)} idle stop is back.` }
}

const help = [
  '/caffeine              turn it on or off for this session',
  '/caffeine on | off',
  '/caffeine warm 1h      keep the cache warm for 1h, then off (90m, 1h30m; alone: 1h)',
  '/caffeine until 18:00  on, and off again at 18:00 (6pm)',
  '/caffeine poke         poke now',
  '/caffeine message …    what the poke says (alone: show it; "reset": the default)',
  '/caffeine auto 100k    turn on by itself once the context passes 100k tokens (off: never)',
  '/caffeine cost         what the pokes cost against one cache rewrite',
  '/caffeine every 10m    poke this long after the last request (alone: back to auto)',
  '/caffeine ttl 1h|5m    pin the cache TTL (auto: back to detecting it)',
  '/caffeine forever      on with no end this time, once confirmed (also: idle off); off restores the idle stop',
  '/caffeine idle 8h      turn off after this long without a turn of your own',
  '/caffeine wake         wake Claude just after the usage limit resets',
  '/caffeine 1 min        wake Claude at a time: in 20 minutes, 2 hours, 14:30, 3pm (also: wake 1 min); wake off cancels',
  '/caffeine 20 min check the build   a wake that tells Claude exactly that',
  '/caffeine wake prompt …  what Claude is told on every wake; wake prompt default goes back',
  '/caffeine wake auto     book the wake by itself whenever the limit hits (on/off)',
  '/caffeine status       what it is doing',
].join('\n')

async function hold($: EngineInterface, c: Caffeine, by: string): Promise<void> {
  c.lastAt = 0
  c.heldBy = by
  await keep($, c)
  await refresh($, c)
}

const c: Caffeine = {
  isOn: false,
  until: 0,
  lastAt: 0,
  activeAt: 0,
  isAutoDeclined: false,
  isForever: false,
  isBusy: false,
  poke: 'none',
  pokeTurnId: '',
  sentAt: 0,
  pokes: 0,
  spent: 0,
  lastPoke: null,
  lastWarm: null,
  limits: [],
  context: 0,
  model: '',
  ttl: null,
  envTtl: null,
  measuredTtl: null,
  isPriced: false,
  timedTtl: null,
  heldBy: '',
  isPokeExempt: false,
  coldAt: 0,
  coldGap: 0,
  message: DEFAULT_MESSAGE,
  every: null,
  idle: DEFAULT_IDLE,
  autoAt: 0,
  armed: null,
  isHit: false,
  isWakeLit: false,
  session: '',
}

export async function warmStart($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'caffeine',
    description: 'Keep the prompt cache warm while you step away, and wake Claude when the usage limit resets',
    argumentHint: '[on|off|status|warm|until|wake|ttl|every|idle|auto|cost|poke|message|forever|help]',
  })
  c.session = await sessionKey($)
  await load($, c)
  try {
    Object.assign(c, await read($, brew))
  } catch {
    // a fresh session: off
  }
  try {
    const usage = await $.session.usage()
    c.limits = [...usage.rateLimits]
  } catch {
    // the first reply brings them
  }
  $.clock.after(50, () => void adopt($, c))
  $.clock.every(5_000, () => void tick($, c))
  // the countdowns
  $.clock.every(30_000, () => {
    if (c.isOn || c.armed) void refresh($, c)
  })
  await refresh($, c)
}

export async function warmMeasure($: EngineInterface, e: { rateLimits: readonly Limit[]; context?: { tokens?: number } }): Promise<void> {
  const wasNear = isNear(c.limits)
  c.limits = [...e.rateLimits]
  c.context = e.context?.tokens ?? c.context
  if (c.autoAt && !c.isOn && !c.isAutoDeclined && c.context >= c.autoAt) {
    await switchOn($, c, true)
    tell($, `on: the context passed ${sized(c.autoAt)} tokens. /caffeine off turns it off for this session.`)
  }
  const block = blocking(c.limits)
  if (block && block.percent >= 100 && !c.armed && (await setting($, 'caffeine.wakeAuto', false))) {
    await armAtReset($, c)
  } else if (!wasNear && isNear(c.limits) && block) {
    $.ui.toast(`caffeine: ${block.label} limit at ${block.percent}%, resets ${clock(block.resetsAt, await $.clock.now())}. /caffeine wake books a wake.`)
  }
  $.ui.invalidate('ui.render')
}

// Each main-thread request reads the cache and restarts its TTL. Its cost can
// prove a 1h write; a cache found cold inside the believed TTL takes that
// back, unless the rewrite priced at 1h itself: then the prefix changed (a
// tool list, an MCP reconnect, a resume), the cache did not expire.
// Each main-thread request reads the cache and restarts its TTL. Its cost can
// prove a 1h write; a cache found cold inside the believed TTL takes that
// back, unless the rewrite priced at 1h itself: then the prefix changed (a
// tool list, an MCP reconnect, a resume), the cache did not expire.
export async function warmStepStart($: EngineInterface, e: { model: string }): Promise<(result: { usage?: Usage & { model?: string } }) => Promise<void>> {
  const at = await $.clock.now()
  const gap = c.lastAt ? at - c.lastAt : 0
  const believed = ttlOf(c)
  // a first request (lastAt is 0 after a compaction or /clear) or another model
  // writes the cache whatever the TTL
  const isExempt = c.lastAt === 0 || (c.model !== '' && c.model !== e.model)
  if (isExempt && c.poke === 'running') c.isPokeExempt = true
  c.model = e.model
  c.lastAt = at
  c.heldBy = ''
  void keep($, c)
  const before = await costNow($)
  return async result => {
    const after = await costNow($)
    if (!result.usage) return
    const priced = before !== null && after !== null ? ttlFromCost(after - before, result.usage, result.usage.model || e.model) : null
    c.isPriced = priced !== null
    if (priced !== null) c.measuredTtl = priced
    const timing = readTiming(gap, result.usage, isExempt)
    // a rewrite priced at 1h was no expiry, so it says nothing about a 5m TTL
    if (timing.ttl !== null && !(timing.isCold && priced !== null)) c.timedTtl = timing.ttl
    if (timing.isCold) {
      c.coldAt = at
      c.coldGap = gap
      // cold inside the believed TTL with no 1h reading of its own: an earlier 1h reading was wrong
      if (gap < believed && priced === null) c.measuredTtl = null
      if (c.isOn && c.poke !== 'running') {
        tell($, `the cache had gone cold after ${span(gap)} idle; this request wrote it again.`)
      }
    }
    if (priced !== null || timing.ttl !== null || timing.isCold) void refresh($, c)
  }
}

export async function warmComplete($: EngineInterface, e: { agentId?: string; turnId: string; usage?: Usage & { model?: string } }): Promise<void> {
  if (e.agentId === undefined) {
    c.isBusy = false
    if (c.poke === 'running' && e.turnId === c.pokeTurnId) {
      c.poke = 'none'
      c.pokes += 1
      if (e.usage) {
        c.lastPoke = e.usage
        c.spent += equivalents(e.usage, e.usage.model || c.model, ttlOf(c))
      }
      const isExempt = c.isPokeExempt
      c.isPokeExempt = false
      // a poke that had to write the cache anyway says nothing about the pokes before it
      if (e.usage && !isExempt && pokeWasCold(e.usage)) {
        c.lastWarm = false
        // a poke inside the TTL found it cold: not 1h, unless the poke's own cost says so
        if (!c.isPriced) c.measuredTtl = null
        await switchOn($, c, false)
        tell(
          $,
          `turned off: its poke found the cache cold (rewrote ${sized(e.usage.cache_creation_input_tokens)} tokens), so pokes were not keeping it warm. /caffeine status may say why; turn it on again to retry.`,
        )
      } else if (e.usage && !isExempt) {
        c.lastWarm = true
      }
    }
    await keep($, c)
    await refresh($, c)
  }
}

export async function warmCompact($: EngineInterface, e: { agentId?: string; trigger?: string }, done: unknown): Promise<void> {
  if (e.agentId === undefined && e.trigger !== 'precompute' && !(done && typeof done === 'object' && 'skip' in done && done.skip)) {
    await hold($, c, 'compaction')
  }
}

export async function warmEnd($: EngineInterface, e: { reason?: string }): Promise<void> {
  if (e.reason === 'clear') await hold($, c, '/clear')
  else if (c.session) await $.store.delete(`warm:${c.session}`).catch(() => undefined)
}

async function caffeineCommand($: EngineInterface, raw: string): Promise<{ text: string }> {

}

// The ▾ button in the cache pill: a dialog of the likeliest next moves; typing in "Other" runs
// any /caffeine argument ("warm 2h", "until 18:00", "wake 30 min").
export async function warmMenu($: EngineInterface): Promise<void> {
  const options = c.isOn ? ['Turn off', 'Poke now', 'Warm for 1 hour', 'Show status'] : ['Turn on', 'Warm for 1 hour', 'Show cost', 'Show status']
  let answer: string
  try {
    answer = await $.ui.ask(`Cache warming is ${c.isOn ? 'on' : 'off'}. Pick one, or type a /caffeine argument.`, { header: 'caffeine', options })
  } catch {
    return
  }
  const args: Record<string, string> = {
    'Turn on': 'on',
    'Turn off': 'off',
    'Poke now': 'poke',
    'Warm for 1 hour': 'warm 1h',
    'Show status': 'status',
    'Show cost': 'cost',
  }
  const result = await caffeineCommand($, args[answer] ?? answer)
  tell($, result.text)
}

// Registers the events token-weather-usage.mjs does not hook; it calls the warm* functions for the rest.
export function warming(on: Parameters<Register>[0]): void {
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') {
      c.isHit = true
      if (!c.armed && (await setting($, 'caffeine.wakeAuto', false))) {
        await armAtReset($, c)
      }
    }
    return next(e)
  })

  // Each main-thread request reads the cache and restarts its TTL. Its cost can
  // prove a 1h write; a cache found cold inside the believed TTL takes that
  // back, unless the rewrite priced at 1h itself: then the prefix changed (a
  // tool list, an MCP reconnect, a resume), the cache did not expire.
  // Each main-thread request reads the cache and restarts its TTL. Its cost can
  // prove a 1h write; a cache found cold inside the believed TTL takes that
  // back, unless the rewrite priced at 1h itself: then the prefix changed (a
  // tool list, an MCP reconnect, a resume), the cache did not expire.
  on('turn.start', async ($, e, next) => {
    c.isBusy = true
    if (c.poke === 'sent' && e.text.includes(c.message)) {
      c.poke = 'running'
      c.pokeTurnId = e.turnId
      c.isPokeExempt = false
    } else {
      c.activeAt = await $.clock.now()
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') {
      c.isHit = false
    }
    return next(e)
  })

  // A compaction or /clear empties the cache: no pokes until the person's next
  // request (or the turn carrying on) writes it again.
  on('command.run', { command: 'caffeine' }, async ($, e) => caffeineCommand($, e.args))
}
