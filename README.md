# dsh-experience

[![CI](https://img.shields.io/github/actions/workflow/status/keyiadiannao/dsh-experience/ci.yml?branch=master)](https://github.com/keyiadiannao/dsh-experience/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

一个**跨会话经验知识库**(自主进化)。它把 agent 在任务中踩过的坑、探索出的解决方案,
沉淀成可复用的"问题 → 解决方案"经验,让模型在**新会话遇到类似问题时**检索并复用——
不重新训练,越用越强。

> 对应前沿:WebCoach(arXiv 2511.12997)的跨会话记忆三组件;Evo-Memory 的
> test-time evolution 思想。数据源是 DSH 已有的 session 日志。

## 三组件(对应 WebCoach)

| 组件 | 文件 | 作用 |
|---|---|---|
| Condenser(压缩) | `extract.mjs` | 把会话轨迹压缩成"问题→解决方案"经验(离线,用 flash) |
| Memory Store(存储) | `store.mjs` + `experience.jsonl` | 持久化经验库 |
| Coach(检索) | `index.mjs`(MCP 工具) | 新会话遇到问题,检索相关经验(零 LLM) |

## 核心原则

- **运行时零 LLM**:检索默认是纯词法(IDF 加权 + 中文 bigram),查询时不花任何 token;
- **可选本地语义检索**:启动本地 embedding 服务(见下)后,检索升级为语义匹配
  (bge-large-zh,本地 GPU/CPU,零云端成本),解决同义词/表述差异;服务未启动时
  自动降级词法;
- **离线才用大模型**:只有 `extract.mjs` 提取经验时调 flash(批量、事后);
- **自主进化**:`extract.mjs` + `add_experience` 持续沉淀,库随任务增长;重复经验自动去重。

## 语义检索(可选,本地 embedding)

缓存里若已有 `BAAI/bge-large-zh-v1.5`(或联网可下载),启动本地服务:

```bash
python embed-server.py          # 默认 127.0.0.1:8001,需 transformers+torch
```

`store.mjs` 检测到该服务后,检索从"词法"自动升级为"语义"(bge 中文 embedding +
query/doc 分离 + 余弦相似度,阈值 0.45 过滤无关,recency 微调);服务挂了则回退词法。

## 用法

### 1. 离线提取经验(唯一用大模型的地方)

```bash
node extract.mjs --latest    # 从最新会话提取
node extract.mjs --all       # 从所有会话提取
node extract.mjs <sessionDir> # 指定会话目录
```

### 2. 运行时检索(MCP 工具)

把 `index.mjs` 挂进 DSH(见下方),agent 遇到问题时可调:

```
mcp__experience__search_experience("git push GitHub TLS 超时怎么办")
  → 返回过去会话里解决过这个问题的经验
```

其余工具:`add_experience`(手动沉淀)、`list_experiences`(浏览)。

## 挂进 DSH

在 `cordis.patch.yml` 的 `insert:` 里加:

```yaml
- id: mcp-experience
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: experience
    transport: stdio
    command: '<node 路径>'
    args:
      - '<本目录>/index.mjs'
```

## 经验条目结构

```json
{
  "id": "…",
  "problem": "问题一句话",
  "solution": "解决方案(含命令/文件/配置细节)",
  "keywords": ["关键词"],
  "sourceSession": "session-…",
  "createdAt": "ISO"
}
```

## 诚实局限

- **"Coach mode" 自动注入尚未实现**:当前是"工具触发"检索——agent 遇到问题时**主动**调
  `search_experience`。完整闭环("工具失败 → 自动检索 → 注入短暂建议 → 成功后提取")需要
  harness hook(`execute.after` / `PostToolUseFailure`),尚未接入;
- **并发**:写入已用进程内锁 + 原子改名 + 唯一临时名,单进程安全;但**多进程**共享同一份
  `experience.jsonl` 仍可能丢更新,生产级应换成 SQLite + WAL;
- **语义检索依赖本地 Python 服务**:`embed-server.py`(bge-large-zh)未启动时自动降级为词法,
  但词法对同义改写、跨语言召回弱;本地 embedding 服务有部署门槛;
- **提取用 flash**:`extract.mjs` 离线批量提取时调 DeepSeek flash,提取质量受模型能力限制;
  且**只在成功恢复后**提取才有意义——失败的尝试不该污染经验库。

## 测试

`node test.mjs`(分词 / 检索 / 持久化 / 并发写不丢更新)。

## License

MIT
