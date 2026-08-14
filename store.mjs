import fs from 'node:fs'

/**
 * store.mjs - experience knowledge base: load/save/search.  Zero dependencies.
 *
 * An experience is a reusable "problem -> solution" lesson:
 *   { id, problem, solution, keywords: [], sourceSession, createdAt }
 *
 * Search is a cheap lexical score (keyword overlap + substring hits) so it runs
 * with ZERO LLM cost at query time.  (Semantic re-ranking can be layered on
 * later via an embedding/LLM call, but the base is free.)
 */

// ---- simple tokenization (CJK chars become bigrams; latin words split) ----
export function tokenize(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_./-]{2,}/g) || []) out.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return [...out]
}

/** Score how relevant an experience is to a query (0..1). */
export function score(exp, queryTokens) {
  const body = `${exp.problem || ''} ${exp.solution || ''} ${(exp.keywords || []).join(' ')}`.toLowerCase()
  let hits = 0
  for (const t of queryTokens) {
    if (body.includes(t)) hits += 1
  }
  const kwHits = (exp.keywords || []).filter((k) => queryTokens.includes(String(k).toLowerCase())).length
  return hits / Math.max(1, queryTokens.length) + kwHits * 0.5
}

export function loadStore(file) {
  const out = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip bad line */ }
    }
  } catch { /* missing file -> empty store */ }
  return out
}

export function saveStore(file, experiences) {
  fs.writeFileSync(file, experiences.map((e) => JSON.stringify(e)).join('\n') + (experiences.length ? '\n' : ''), 'utf8')
}

export function addExperience(file, exp, idGen = Date.now) {
  const store = loadStore(file)
  const e = {
    id: `${idGen()}-${store.length}`,
    problem: String(exp.problem || '').slice(0, 300),
    solution: String(exp.solution || '').slice(0, 1000),
    keywords: (exp.keywords || []).map((k) => String(k).slice(0, 40)),
    sourceSession: exp.sourceSession || '',
    createdAt: exp.createdAt || new Date().toISOString(),
  }
  store.push(e)
  saveStore(file, store)
  return e
}

export function search(store, query, k = 5) {
  const qt = tokenize(query)
  const scored = store
    .map((e) => ({ e, s: score(e, qt) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored.slice(0, k).map((x) => ({ ...x.e, score: Number(x.s.toFixed(3)) }))
}
