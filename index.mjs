/**
 * index.mjs - MCP server for the cross-session experience knowledge base.
 *
 * Tools:
 *   search_experience - given a problem, return the most relevant past
 *                       "problem -> solution" experiences (zero-LLM lexical)
 *   add_experience    - manually record a new lesson (also grows the KB)
 *   list_experiences  - list the KB (optionally filter)
 *
 * The agent calls search_experience when it hits a problem, so it can reuse how
 * a similar problem was solved in a past session — cross-session learning
 * without retraining.  Self-evolving: extract.mjs + add_experience keep growing
 * the store as tasks run.
 */
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStore, search, addExperience } from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(HERE, 'experience.jsonl')

const TOOLS = [
  {
    name: 'search_experience',
    description: '检索跨会话经验库：给定当前遇到的问题，返回过去会话中解决类似问题的经验（问题→解决方案）。零 LLM 成本，纯词法检索。',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: '当前遇到的问题描述' },
        topk: { type: 'number', description: '返回前几条（默认 5）' },
      },
      required: ['problem'],
    },
  },
  {
    name: 'add_experience',
    description: '手动记录一条新的可复用经验（问题→解决方案+关键词），沉淀进跨会话知识库。',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: '问题一句话' },
        solution: { type: 'string', description: '解决方案' },
        keywords: { type: 'array', items: { type: 'string' }, description: '关键词（可选）' },
      },
      required: ['problem', 'solution'],
    },
  },
  {
    name: 'list_experiences',
    description: '列出知识库里的经验（可选按关键词过滤）。',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: '关键词过滤（可选）' } },
    },
  },
]

function toolResult(text) { return { content: [{ type: 'text', text }] } }

async function callTool(name, args = {}) {
  switch (name) {
    case 'search_experience': {
      const store = loadStore(STORE)
      const topk = Number.isFinite(args.topk) ? args.topk : 5
      const hits = await search(store, args.problem, topk)
      if (hits.length === 0) return toolResult(JSON.stringify({ found: false, count: store.length, note: '知识库中无相关经验' }, null, 2))
      return toolResult(JSON.stringify({ found: true, count: hits.length, results: hits.map((h) => ({ problem: h.problem, solution: h.solution, keywords: h.keywords, score: h.score, sourceSession: h.sourceSession })) }, null, 2))
    }
    case 'add_experience': {
      const e = await addExperience(STORE, { problem: args.problem, solution: args.solution, keywords: args.keywords || [] })
      return toolResult(JSON.stringify({ added: !e.duplicate && !e.updated, updated: e.updated === true, duplicate: e.duplicate === true, id: e.id, problem: e.problem }, null, 2))
    }
    case 'list_experiences': {
      let store = loadStore(STORE)
      if (args.filter) {
        const f = String(args.filter).toLowerCase()
        store = store.filter((e) => `${e.problem} ${e.solution} ${(e.keywords || []).join(' ')}`.toLowerCase().includes(f))
      }
      return toolResult(JSON.stringify({ count: store.length, experiences: store.map((e) => ({ id: e.id, problem: e.problem, keywords: e.keywords })) }, null, 2))
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
}

// ---- stdio JSON-RPC ----
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
function send(o) { process.stdout.write(JSON.stringify(o) + '\n') }

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-experience', version: '0.1.0' } } })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return }
  if (msg.method === 'tools/call') {
    try {
      const res = await callTool(msg.params?.name, msg.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: msg.id, result: res })
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } })
    }
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
rl.on('close', () => process.exit(0))
