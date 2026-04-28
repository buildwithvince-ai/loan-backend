#!/usr/bin/env node
/**
 * Backfill missing borrower fields in Loandisk for past approved applications.
 *
 * For each approved application with a loandisk_borrower_id:
 *   1. GET the current Loandisk borrower record.
 *   2. Build the new payload from form_data using the updated mapper.
 *   3. Diff the two — if any of the audited fields are blank/different in
 *      Loandisk, mark for update.
 *   4. In --live mode, PUT the updated borrower. In --dry-run (default), only
 *      print the diff.
 *
 * Usage:
 *   node scripts/backfill-loandisk-borrowers.js              # dry-run (default)
 *   node scripts/backfill-loandisk-borrowers.js --live       # actually PUT updates
 *   node scripts/backfill-loandisk-borrowers.js --limit 10   # cap rows processed
 *   node scripts/backfill-loandisk-borrowers.js --id <appId> # single application
 *
 * Loandisk rate limit: 1000 req / 5 min. Each row = 2 reqs (GET + PUT). Script
 * sleeps 350ms between rows to stay well under.
 */

require('dotenv').config()
const { supabase } = require('../services/supabase')
const { getBorrower, updateBorrower, buildBorrowerPayload } = require('../services/loandisk')

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const LIMIT = parseArg('--limit', null)
const SINGLE_ID = parseArg('--id', null)
const SLEEP_MS = parseInt(parseArg('--sleep', '350'), 10)

// Fields we care about backfilling (subset of Loandisk borrower payload).
// If any of these is empty in current Loandisk record OR differs from new
// payload, we update.
const AUDITED_FIELDS = [
  'borrower_firstname',
  'borrower_lastname',
  'borrower_dob',
  'borrower_address',
  'borrower_city',
  'borrower_province',
  'borrower_zipcode',
  'borrower_email',
  'borrower_mobile',
  'borrower_business_name',
  'borrower_description',
  'custom_field_26904', // Barangay
  'custom_field_27065', // Finscore Score
  'custom_field_27066', // Finscore Risk Band
  'custom_field_27067'  // Finscore Fraud Flag
]

function parseArg(flag, defaultVal) {
  const i = args.indexOf(flag)
  if (i === -1) return defaultVal
  return args[i + 1]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function diffFields(current, next) {
  // Return list of {field, before, after} where current is empty/different.
  const diffs = []
  for (const key of AUDITED_FIELDS) {
    const cur = norm(current?.[key])
    const nxt = norm(next?.[key])
    if (!nxt) continue // nothing to push for this field
    if (cur !== nxt) diffs.push({ field: key, before: cur, after: nxt })
  }
  return diffs
}

function norm(v) {
  if (v == null) return ''
  return String(v).trim()
}

async function fetchApprovedRows() {
  let query = supabase
    .from('applications')
    .select('id, reference_id, full_name, status, loandisk_borrower_id, form_data, finscore_raw')
    .not('loandisk_borrower_id', 'is', null)
    .eq('status', 'approved')

  if (SINGLE_ID) query = query.eq('id', SINGLE_ID)
  if (LIMIT) query = query.limit(parseInt(LIMIT, 10))

  query = query.order('reviewed_at', { ascending: true })
  const { data, error } = await query
  if (error) throw error
  return data || []
}

async function main() {
  console.log('==========================================')
  console.log(' Loandisk Borrower Backfill')
  console.log(`  mode = ${LIVE ? 'LIVE' : 'DRY-RUN'}`)
  if (LIMIT) console.log(`  limit = ${LIMIT}`)
  if (SINGLE_ID) console.log(`  single id = ${SINGLE_ID}`)
  console.log(`  sleep between rows = ${SLEEP_MS}ms`)
  console.log('==========================================\n')

  const rows = await fetchApprovedRows()
  console.log(`Fetched ${rows.length} approved application(s) with loandisk_borrower_id\n`)

  const counts = { processed: 0, no_diff: 0, updated: 0, skipped: 0, failed: 0 }

  for (const row of rows) {
    counts.processed += 1
    const tag = `[${row.reference_id || row.id} -> Loandisk #${row.loandisk_borrower_id}]`

    try {
      const finScore = { score: row.finscore_raw, riskBand: 'N/A', fraudFlag: 'false' }
      const nextPayload = buildBorrowerPayload(row.form_data, finScore)

      let current
      try {
        current = await getBorrower(row.loandisk_borrower_id)
      } catch (err) {
        console.error(`${tag} GET failed status=${err.response?.status} — skipping`)
        counts.failed += 1
        await sleep(SLEEP_MS)
        continue
      }

      const diffs = diffFields(current, nextPayload)

      if (diffs.length === 0) {
        console.log(`${tag} no diff — skipping`)
        counts.no_diff += 1
        await sleep(SLEEP_MS)
        continue
      }

      console.log(`${tag} ${diffs.length} field(s) need backfill:`)
      for (const d of diffs) {
        const beforeShown = d.before === '' ? '(empty)' : truncate(d.before, 80)
        const afterShown = truncate(d.after, 80)
        console.log(`    ${d.field}: ${beforeShown}  ->  ${afterShown}`)
      }

      if (!LIVE) {
        counts.skipped += 1
        await sleep(SLEEP_MS)
        continue
      }

      try {
        await updateBorrower(row.loandisk_borrower_id, row.form_data, finScore, { currentBorrower: current })
        console.log(`${tag} UPDATED`)
        counts.updated += 1
      } catch (err) {
        console.error(`${tag} PUT failed status=${err.response?.status} msg=${err.message}`)
        counts.failed += 1
      }

      await sleep(SLEEP_MS)
    } catch (err) {
      console.error(`${tag} unexpected error:`, err.message)
      counts.failed += 1
      await sleep(SLEEP_MS)
    }
  }

  console.log('\n==========================================')
  console.log(' Backfill Summary')
  console.log(`  processed = ${counts.processed}`)
  console.log(`  no_diff   = ${counts.no_diff}`)
  console.log(`  updated   = ${counts.updated}`)
  console.log(`  skipped   = ${counts.skipped}  ${LIVE ? '' : '(would-update; re-run with --live)'}`)
  console.log(`  failed    = ${counts.failed}`)
  console.log('==========================================')
}

function truncate(s, max) {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}...` : s
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
