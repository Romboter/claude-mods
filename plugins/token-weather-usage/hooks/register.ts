// One module per plugin: token-weather-usage.mjs draws the band and hooks the events cache-warm.ts
// shares; warming() registers the rest of the cache warming (the /caffeine command and its prompts).
import type { Register } from 'claude-code'

import { warming } from './cache-warm'
// @ts-ignore plain JavaScript
import { register as weather } from './token-weather-usage.mjs'

export const register: Register = (on, options) => {
  weather(on, options)
  warming(on)
}
