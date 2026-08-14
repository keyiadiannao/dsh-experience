# dsh-experience

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

- **运行时零 LLM**:检索是纯词法(关键词 + 中文 bigram),查询时不花任何 token;
- **离线才用大模型**:只有 `extract.mjs` 提取经验时调 flash(批量、事后);
- **自主进化**:`extract.mjs` + `add_experience` 持续沉淀,库随任务增长。

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

测试:`node test.mjs`(分词 / 检索 / 持久化)。
