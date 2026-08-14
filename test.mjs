/**
 * test.mjs - unit tests for the experience store + search.
 * Run: node test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize, score, search, addExperience, loadStore } from './store.mjs'

let pass = 0, fail = 0
function ok(cond, name) { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }

const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '_test-store.jsonl')
try { fs.unlinkSync(tmp) } catch { /* ignore */ }

console.log('--- 分词 ---')
ok(tokenize('zstd decode session.jsonl.zstd').includes('zstd'), '英文分词含 zstd')
ok(tokenize('解码').length >= 1, '中文分词非空')
ok(tokenize('解码').includes('解码'), '中文单字被保留')

console.log('--- 添加 + 检索 ---')
const e1 = addExperience(tmp, { problem: 'zstd 解码 session.jsonl.zstd 失败', solution: '用 node:zlib 的 zstdDecompressSync 逐 frame 扫描解码', keywords: ['zstd', '解码', 'frame'], sourceSession: 's1' })
const e2 = addExperience(tmp, { problem: 'PowerShell Set-Content 写文件带 BOM', solution: '用 Python open(..., encoding=utf-8) 重写去掉 BOM', keywords: ['BOM', 'PowerShell', '编码'], sourceSession: 's2' })
ok(e1.id && e2.id, '添加两条经验成功')

const hits = search(loadStore(tmp), 'zstd 解码 session 文件', 5)
ok(hits.length >= 1, '检索 zstd 解码有结果')
ok(hits[0].problem.includes('zstd'), `最相关的是 zstd 经验（实际 "${hits[0].problem}"）`)

const hits2 = search(loadStore(tmp), '写文件出现 BOM 乱码', 5)
ok(hits2.length >= 1 && hits2[0].problem.includes('BOM'), `检索 BOM 有结果（实际 "${hits2[0]?.problem}"）`)

const none = search(loadStore(tmp), '完全无关的量子计算', 5)
ok(none.length === 0, '无关查询返回空')

console.log('--- 持久化 ---')
const reloaded = loadStore(tmp)
ok(reloaded.length === 2, '重新加载后仍 2 条（持久化）')

try { fs.unlinkSync(tmp) } catch { /* ignore */ }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
