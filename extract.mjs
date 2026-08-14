/**
 * extract.mjs - OFFLINE experience extraction from a finished DSH session.
 *
 * Reads the session log, compresses it to an activity stream, and asks
 * deepseek-v4-flash (reasoning off) to extract reusable "problem -> solution"
 * lessons.  This is the ONLY place a big model runs, and it is offline/batch —
 * the runtime search (store.mjs) costs zero LLM.
 *
 * Usage:
 *   node extract.mjs [sessionDir]      # a specific session dir, or
 *   node extract.mjs --latest          # newest session, or
 *   node extract.mjs --all             # every session under sessionsRoot
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { addExperience, loadStore } from './store.mjs'

const MAGIC = 0xFD2FB528
const HERE = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(HERE, 'experience.jsonl')

// ---- zstd decode (ported from dsh-session-persistence-jsonl, MIT) ----
function scanZstdFrames(buffer) {
  const frames = []; let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const bh = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (bh & 1) !== 0
      const bt = (bh >>> 1) & 0x03
      const bs = bh >>> 3
      offset += bt === 0x01 ? 1 : bs
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}
function decodeSessionLog(fp) {
  if (!fs.existsSync(fp)) return []
  const buf = fs.readFileSync(fp)
  let text = ''
  for (const f of scanZstdFrames(buf)) { try { text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { /* torn */ } }
  const ev = []
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { ev.push(JSON.parse(line)) } catch { /* partial */ } }
  return ev
}
function discoverSessions(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const s of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const log = path.join(root, ws.name, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(log)) out.push({ dir: path.join(root, ws.name, s.name), name: s.name, log, mtime: fs.statSync(log).mtimeMs })
    }
  }
  return out
}

// ---- condense events to an activity stream ----
function userText(c) { return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x?.type === 'text' ? x.text : '')).join(' ') : '' }
function toolText(m) {
  const walk = (x) => typeof x === 'string' ? x : Array.isArray(x) ? x.map(walk).join('\n') : (x && typeof x === 'object') ? (x.type === 'text' && typeof x.text === 'string' ? x.text : Object.values(x).map(walk).join('\n')) : ''
  return walk(m)
}
function activityStream(events) {
  const lines = []
  let task = ''
  for (const e of events) {
    if (e.type === 'user/message') { const t = userText(e.data?.content).trim(); if (t && !t.startsWith('<system-reminder>') && !task) task = t }
    else if (e.type === 'tool/call') lines.push(`执行: ${e.data?.name ?? '?'} ${(JSON.stringify(e.data?.arguments ?? {}).slice(0, 120))}`)
    else if (e.type === 'tool/result') { const t = toolText(e.data?.message).replace(/\s+/g, ' ').slice(0, 200); lines.push(`结果: ${t}`) }
  }
  return { task, lines }
}

// ---- flash client ----
function readKey() {
  try { const m = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/); if (m) return m[1] } catch { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || ''
}
async function extractExperiences(task, lines) {
  const key = readKey()
  if (!key) return { error: 'no key' }
  const prompt = [
    '你是经验提取器。看下面这个 agent 会话的执行轨迹，提取可复用的"问题 → 解决方案"经验。',
    '要求：每条经验具体、可复用、含命令/文件/配置细节；忽略琐碎的一次性操作；最多提取 5 条；没有可复用经验就返回空数组。',
    '',
    `任务: ${task || '(未提供)'}`,
    '',
    '执行轨迹（节选）:',
    ...lines.slice(0, 120).map((l, i) => `${i + 1}. ${l}`),
    '',
    '只输出 JSON: {"experiences": [{"problem": "问题一句话", "solution": "解决方案", "keywords": ["关键词1", "关键词2"]}]}',
  ].join('\n')
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', reasoning_effort: 'none', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) return { error: `api:${res.status}` }
  const j = await res.json()
  try { return JSON.parse(String(j.choices?.[0]?.message?.content ?? '{}').replace(/```json|```/g, '').trim()) } catch { return { error: 'parse' } }
}

async function processSession(sess) {
  const events = decodeSessionLog(sess.log)
  if (events.length === 0) return 0
  const { task, lines } = activityStream(events)
  const result = await extractExperiences(task, lines)
  if (result.error || !Array.isArray(result.experiences)) { console.log(`  [skip] ${sess.name}: ${result.error || 'no experiences'}`); return 0 }
  const before = loadStore(STORE).length
  for (const e of result.experiences) {
    if (e.problem && e.solution) await addExperience(STORE, { ...e, sourceSession: sess.name })
  }
  const after = loadStore(STORE).length
  console.log(`  [ok] ${sess.name}: +${after - before} experiences (${task.slice(0, 40)})`)
  return after - before
}

async function main() {
  const arg = process.argv[2] || '--latest'
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  const sessions = discoverSessions(root)
  let targets = []
  if (arg === '--all') targets = sessions
  else if (arg === '--latest') { if (sessions.length) targets = [sessions.reduce((a, b) => (a.mtime > b.mtime ? a : b))] }
  else targets = [{ dir: arg, name: path.basename(arg), log: path.join(arg, 'session.jsonl.zstd'), mtime: 0 }]

  console.log(`[extract] store=${STORE} · ${targets.length} session(s)`)
  let total = 0
  for (const s of targets) total += await processSession(s)
  console.log(`[extract] done, ${total} new experiences, store total=${loadStore(STORE).length}`)
}

main()
