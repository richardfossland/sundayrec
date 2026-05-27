#!/usr/bin/env node
/* eslint-disable */
/**
 * Ad-hoc smoke test for the vendored grandiose NDI bindings.
 *
 * Loads the native module, runs a 2-second NDI source discovery on the local
 * network, and prints what was found. Used during initial development to
 * confirm the build is functional. Not part of the test suite — it requires
 * an actual NDI source on the network to find anything interesting.
 *
 * Run with: node scripts/test-ndi.js
 */

const path = require('path')
const grandiose = require(path.join(__dirname, '..', 'vendor', 'grandiose'))

console.log('[ndi-test] grandiose loaded')
console.log('[ndi-test] version:', grandiose.version ? grandiose.version() : '(unknown)')
console.log('[ndi-test] available functions:', Object.keys(grandiose).join(', '))

;(async () => {
  console.log('[ndi-test] starting find for 2 s …')
  const finder = await grandiose.find({ showLocalSources: true })
  await new Promise(r => setTimeout(r, 2000))
  const sources = await finder.sources()
  console.log(`[ndi-test] found ${sources.length} source(s):`)
  for (const s of sources) {
    console.log('  •', JSON.stringify(s))
  }
  finder.destroy()
  console.log('[ndi-test] done')
})().catch(err => {
  console.error('[ndi-test] error:', err)
  process.exit(1)
})
