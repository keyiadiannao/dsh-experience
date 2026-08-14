import fs from 'node:fs'

/**
 * store.mjs - experience knowledge base: load/save/search.  Zero dependencies.
 *
 * An experience is a reusable "problem -> solution" lesson:
 *   { id, problem, solution, keywords: [], sourceSession, createdAt }
 *
 * Search is a cheap lexical score with THREE refinements over naive overlap:
 *   - IDF weighting: rare tokens matter more than ubiquitous ones ("git"/"file"
 *     appear everywhere, "zstd"/"TLS" are discriminating);
 *   - keyword hits are weighted extra (they are hand-picked signals);
 *   - recency: newer lessons get a mild boost (30-day half-life).
 *
 * Still ZERO LLM cost at query time.  (Semantic re-ranking can be layered on
 * later via an embedding/LLM call, but the base is free.)
 */

// ---- tokenization (CJK chars become bigrams; latin words split) ----
export function tokenize(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_./-]{2,}/g) || []) out.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return [...out]
}

/** Inverse document frequency over the whole store: rare tokens score higher. */
export function computeIdf(store) {
  const df = {}
  for (const exp of store) {
    for (const t of tokenize(`${exp.problem} ${exp.solution} ${(exp.keywords || []).join(' ')}`)) {
      df[t] = (df[t] || 0) + 1
    }
  }
  const N = store.length || 1
  const idf = {}
  for (const t in df) idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1
  return idf
}

/** Raw relevance score of one experience to the query tokens (idf-weighted). */
export function score(exp, queryTokens, idf) {
  const body = `${exp.problem || ''} ${exp.solution || ''}`.toLowerCase()
  let s = 0
  for (const t of queryTokens) {
    if (body.includes(t)) s += (idf && idf[t]) ? idf[t] : 1
  }
  // hand-picked keywords are strong signals
  for (const k of exp.keywords || []) {
    if (queryTokens.includes(String(k).toLowerCase())) s += 1.5
  }
  return s
}

/** Jaccard similarity of two texts (token sets), 0..1. */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

// ---- semantic embedding (optional; falls back to lexical when service is down) ----
const EMBED_URL = process.env.EMBED_URL || 'http://127.0.0.1:8001/embed'
const SEM_THRESHOLD = 0.45 // minimum cosine to consider a doc relevant (semantic mode)

/** Embed a query + docs via the local embed-server.  Returns {query, docs} or null. */
export async function embedQueryDocs(query, docs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, docs }),
      signal: ctrl.signal,
    })
    if (!r.ok) return null
    const j = await r.json()
    return Array.isArray(j.query) && Array.isArray(j.docs) ? j : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
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
  // near-identical problem already present?
  const dup = store.find((e) => similarity(e.problem, exp.problem) > 0.7)
  if (dup) {
    // Same problem, DIFFERENT solution (method changed) -> UPDATE the old entry,
    // bump its timestamp so recency re-promotes it, rather than ignoring the new
    // knowledge or growing a contradictory duplicate.
    if (similarity(dup.solution, exp.solution) < 0.6) {
      dup.solution = String(exp.solution || '').slice(0, 1000)
      const kw = new Set([...(dup.keywords || []), ...(exp.keywords || [])])
      dup.keywords = [...kw].slice(0, 8).map((k) => String(k).slice(0, 40))
      dup.sourceSession = exp.sourceSession || dup.sourceSession
      dup.updatedAt = new Date().toISOString()
      dup.createdAt = dup.updatedAt // refresh recency: this is now the current method
      saveStore(file, store)
      return { ...dup, updated: true }
    }
    return { ...dup, duplicate: true }
  }
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

export async function search(store, query, k = 5) {
  const qt = tokenize(query)
  const idf = computeIdf(store)
  const now = Date.now()
  const HALF_LIFE = 30 * 24 * 3600 * 1000 // 30 days

  // lexical scores (always available)
  const lexScores = store.map((e) => score(e, qt, idf))
  const maxLex = Math.max(...lexScores, 1e-6)

  // semantic scores (optional; null if embed service down)
  let semScores = null
  if (store.length > 0) {
    const docs = store.map((e) => `${e.problem} ${e.solution}`)
    const emb = await embedQueryDocs(query, docs)
    if (emb && emb.docs.length === store.length) {
      semScores = store.map((_, i) => cosine(emb.query, emb.docs[i]))
    }
  }

  const scored = store
    .map((e, i) => {
      const recency = Math.exp(-(now - new Date(e.createdAt || now).getTime()) / HALF_LIFE)
      // semantic (cosine 0..1) is the authoritative signal when available;
      // lexical (normalized) is only a fallback when the embed service is down.
      const base = semScores ? semScores[i] : lexScores[i] / maxLex
      if (semScores && semScores[i] < SEM_THRESHOLD) return null // filter out irrelevant
      if (!semScores && base <= 0) return null
      const total = base * (0.8 + 0.2 * recency)
      return { e, s: total }
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
  return scored.slice(0, k).map((x) => ({ ...x.e, score: Number(x.s.toFixed(3)) }))
}
