#!/usr/bin/env node
/**
 * Summarize `gates.jsonl` and show what different `review.jev.confidentNo`
 * values would have done on the same traffic.
 *
 * Tuning needs ground truth the log cannot provide (was a skipped turn actually
 * worth a skill?), so this prints the evidence and the trade-off table instead
 * of pretending to pick a number.
 *
 * Usage: node scripts/gate-stats.mjs [path/to/gates.jsonl]
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const defaultPath = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'self-evolve', 'gates.jsonl')
const path = process.argv[2] ?? defaultPath

function percentile(values, p) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[index]
}

function fmt(value, digits = 2) {
  return value === undefined ? '—' : value.toFixed(digits)
}

let text
try {
  text = await readFile(path, 'utf8')
} catch {
  console.log(`No gate log at ${path}`)
  console.log('The gate writes one line per decision once a review comes due; run this again later.')
  process.exit(0)
}

const entries = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    entries.push(JSON.parse(line))
  } catch {
    // Ignore a torn final line.
  }
}

if (entries.length === 0) {
  console.log(`Gate log at ${path} is empty.`)
  process.exit(0)
}

const jev = entries.filter((entry) => entry.source === 'jev')
const skips = entries.filter((entry) => entry.decision === 'skip')
const fallbacks = entries.filter((entry) => entry.source === 'counters' && String(entry.reason ?? '').startsWith('fallback'))
const choices = { yes: 0, no: 0, unclear: 0 }
for (const entry of jev) {
  if (entry.choice in choices) choices[entry.choice] += 1
}
const noConfidences = jev.filter((entry) => entry.choice === 'no').map((entry) => Number(entry.confidence)).filter(Number.isFinite)
const latencies = entries.map((entry) => Number(entry.latencyMs)).filter(Number.isFinite)
const current = [...entries].reverse().find((entry) => typeof entry.threshold === 'number')?.threshold
const first = entries[0]?.at
const last = entries[entries.length - 1]?.at

console.log(`gate log: ${path}`)
console.log(`window:   ${first} → ${last}`)
console.log('')
console.log(`decisions: ${entries.length} (review ${entries.length - skips.length}, skip ${skips.length})`)
console.log(`sources:   jev ${jev.length}, counters ${entries.length - jev.length} (fallbacks ${fallbacks.length})`)
if (jev.length > 0) {
  console.log(`choices:   yes ${choices.yes}, no ${choices.no}, unclear ${choices.unclear}`)
}
if (noConfidences.length > 0) {
  console.log(`no confidence: p10 ${fmt(percentile(noConfidences, 0.1))}, median ${fmt(percentile(noConfidences, 0.5))}, p90 ${fmt(percentile(noConfidences, 0.9))}`)
}
if (latencies.length > 0) {
  console.log(`latency:   median ${fmt(percentile(latencies, 0.5), 0)} ms, p90 ${fmt(percentile(latencies, 0.9), 0)} ms`)
}
if (fallbacks.length > 0) {
  const reasons = new Map()
  for (const entry of fallbacks) {
    const key = String(entry.reason ?? 'fallback')
    reasons.set(key, (reasons.get(key) ?? 0) + 1)
  }
  console.log(`fallback reasons:`)
  for (const [reason, count] of reasons) console.log(`  ${count}× ${reason}`)
}

if (jev.length === 0) {
  console.log('')
  console.log('No Jev decisions yet — either the gate is not enabled or no review has come due.')
  process.exit(0)
}

console.log('')
console.log(`threshold trade-off (current ${current ?? 'unknown'})`)
console.log('  threshold  skipped  share of "no"  reviews kept')
const candidates = new Set([0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95])
if (typeof current === 'number') candidates.add(Number(current.toFixed(2)))
for (const threshold of [...candidates].sort((a, b) => a - b)) {
  const skipped = noConfidences.filter((confidence) => confidence >= threshold).length
  const share = noConfidences.length === 0 ? 0 : skipped / noConfidences.length
  const marker = typeof current === 'number' && Math.abs(current - threshold) < 1e-9 ? '  ← current' : ''
  console.log(
    `  ${threshold.toFixed(2)}       ${String(skipped).padStart(3)}      ${(share * 100).toFixed(0).padStart(3)}%          ${jev.length - skipped}${marker}`,
  )
}

console.log('')
console.log('Read it as: each skipped line is a review you did not pay for.')
console.log('Raise the threshold if a skipped turn later proved to carry a lesson; lower it if reviews keep finding nothing.')
