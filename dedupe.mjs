/**
 * dedupe.mjs - offline SEMANTIC dedup of the experience store.
 *
 * Uses the local bge embed-server to compute pairwise cosine similarity of all
 * problems, greedily clusters near-duplicates (threshold 0.82), keeps the most
 * recent entry per cluster and merges its keywords.  Fixes the "same lesson
 * extracted N times from N sessions with different wording" problem.
 *
 * Run: node dedupe.mjs [threshold]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStore, saveStore, cosine } from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(HERE, 'experience.jsonl')
const EMBED = 'http://127.0.0.1:8001/embed'
const THRESHOLD = Number(process.argv[2]) || 0.82

const store = loadStore(STORE)
console.log(`store: ${store.length} experiences`)

// embed all problems (pure doc mode, no query instruction)
const r = await fetch(EMBED, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: store.map((e) => e.problem) }) })
if (!r.ok) { console.error('embed-server unreachable — start it first (start-embed.bat)'); process.exit(1) }
const vecs = (await r.json()).vectors

// greedy clustering
const clusters = []
for (let i = 0; i < store.length; i++) {
  let found = null
  for (const c of clusters) {
    if (cosine(vecs[i], vecs[c.repIdx]) > THRESHOLD) { found = c; break }
  }
  if (found) found.members.push(i)
  else clusters.push({ repIdx: i, members: [i] })
}

// merge each cluster: keep newest, union keywords
const kept = []
const merged = []
for (const c of clusters) {
  if (c.members.length > 1) {
    merged.push(c.members.map((i) => store[i].problem.slice(0, 28)))
  }
  c.members.sort((a, b) => new Date(store[b].createdAt).getTime() - new Date(store[a].createdAt).getTime())
  const rep = { ...store[c.members[0]] }
  const kw = new Set()
  for (const i of c.members) for (const k of store[i].keywords || []) kw.add(k)
  rep.keywords = [...kw].slice(0, 8)
  kept.push(rep)
}

console.log(`\nmerged ${store.length - kept.length} duplicates -> ${kept.length} unique`)
for (const group of merged) {
  console.log('  --- 合并一组:')
  for (const g of group) console.log('      ' + g)
}

// sort newest first for stable ordering
kept.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
saveStore(STORE, kept)
console.log(`\nwritten ${kept.length} experiences to experience.jsonl`)

// re-embed after merge (some kept entries lost their embedding via {...spread})
const { ensureEmbeddings } = await import('./store.mjs')
const n = await ensureEmbeddings(STORE)
console.log(`ensured embeddings: ${n < 0 ? 'embed-server down (lexical fallback only)' : `${n} embedded`}`)
