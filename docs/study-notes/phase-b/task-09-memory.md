---
---
# Task 09：上下文与内存管理精读

> 研究日期：2026-03-31
> 覆盖文件：memdir/memdir.ts, memdir/memoryTypes.ts, memdir/paths.ts,
> services/compact/autoCompact.ts, services/compact/compact.ts (前 400+ 行),
> services/compact/prompt.ts, services/extractMemories/extractMemories.ts,
> services/extractMemories/prompts.ts, utils/sessionStorage.ts (前 320 行)

---

## 三层内存架构全景

```
┌──────────────────────────────────────────────────────────────────────┐
│ 长期内存（memory files / memdir）                                      │
│                                                                      │
│ 路径：<memoryBase>/projects/<sanitized-git-root>/memory/             │
│       其中 memoryBase 默认 ~/.claude，CCR 时由                        │
│       CLAUDE_CODE_REMOTE_MEMORY_DIR 覆盖                             │
│                                                                      │
│ 加载：每次对话启动时通过 loadMemoryPrompt() 注入 system prompt         │
│       • MEMORY.md（索引，最多 200 行 / 25KB）直接嵌入提示文字           │
│       • 完整 topic 文件由 LLM 按需 Read                               │
│                                                                      │
│ 写入：两条路径                                                         │
│   A. 主 agent 在对话中显式 Write/Edit（用户说"记住…"）                 │
│   B. 后台 extractMemories 子代理（每轮对话结束时异步触发）              │
└──────────────────────────────────────────────────────────────────────┘
                    ↑ 提取自对话历史

┌──────────────────────────────────────────────────────────────────────┐
│ 中期内存（compact 摘要）                                               │
│                                                                      │
│ 存储：随会话历史一起持久化到 JSONL，作为 compact boundary 后的         │
│       user message 重新加载到下次 API 请求                             │
│                                                                      │
│ 触发：token 使用量超过自动压缩阈值                                      │
│   threshold = effectiveContextWindow - 13,000（AUTOCOMPACT_BUFFER） │
│   effectiveContextWindow = modelContextWindow - min(maxOutput, 20K)  │
│                                                                      │
│ 生成：LLM 对话摘要（forked agent 共享 prompt cache）                   │
└──────────────────────────────────────────────────────────────────────┘
                    ↑ 压缩自

┌──────────────────────────────────────────────────────────────────────┐
│ 短期内存（session messages / sessionStorage）                         │
│                                                                      │
│ 路径：<projectsDir>/<sanitized-cwd>/<sessionId>.jsonl                │
│       projectsDir = ~/.claude/projects/                              │
│                                                                      │
│ 格式：JSONL（每行一个 JSON 对象）                                       │
│ 链接：parentUuid 字段形成链式结构（类 git commit chain）               │
│ 生命周期：会话内持久 → 可通过 --resume 恢复                            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 一、长期内存（memdir / memory files）

### 1. 存储路径

**关键函数**：`getAutoMemPath()` in `memdir/paths.ts`

路径解析优先级（第一个命中的获胜）：
1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 环境变量（Cowork 专用，完整路径覆盖）
2. settings.json 中的 `autoMemoryDirectory` 字段（支持 `~/` 展开；仅信任 policy/local/user 源，projectSettings 被排除以防恶意仓库劫持写路径）
3. 默认计算路径：

```
<memoryBaseDir>/projects/<sanitized(canonicalGitRoot)>/memory/
```

其中：
- `memoryBaseDir`：默认 `~/.claude`，CCR 时为 `CLAUDE_CODE_REMOTE_MEMORY_DIR`
- `canonicalGitRoot`：`findCanonicalGitRoot(projectRoot)`，git worktree 场景下所有 worktree 共享同一 memory 目录
- `sanitizePath()`：将项目路径转成安全的目录名（处理特殊字符）

**结果示例**：
```
~/.claude/projects/Users-alice-works-myproject/memory/
```

---

### 2. `loadMemoryPrompt()` 的逻辑

**文件**：`memdir/memdir.ts` line 419

```
loadMemoryPrompt()
  │
  ├─ feature('KAIROS') && getKairosActive()
  │    └─→ buildAssistantDailyLogPrompt()（助手模式：按日志追加，不维护 MEMORY.md）
  │
  ├─ feature('TEAMMEM') && isTeamMemoryEnabled()
  │    └─→ buildCombinedMemoryPrompt()（auto + team 两个目录）
  │
  ├─ isAutoMemoryEnabled()
  │    └─→ buildMemoryLines()（单 auto 目录，返回指令文本但不含 MEMORY.md 内容）
  │         注意：这里只返回"如何使用内存"的指令，MEMORY.md 内容通过 claudemd.ts
  │         的 getMemoryFiles() 路径注入（并非 buildMemoryPrompt）
  │
  └─ disabled → 返回 null（记录 telemetry）
```

**注入位置**：`loadMemoryPrompt()` 的结果作为 `systemPromptSection('memory', ...)` 的一部分，最终拼接在 system prompt 中。MEMORY.md 的实际内容通过 `claudemd.ts` 在 user context 部分注入（区分 agent mode 和普通 mode）。

**MEMORY.md 截断保护**：
- 超过 200 行：只保留前 200 行
- 超过 25,000 字节：在最后一个换行处截断
- 触发任一上限时，在末尾追加警告注释

---

### 3. MemoryType 四类型分类

**文件**：`memdir/memoryTypes.ts`

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
```

| 类型 | 用途 | 范围（team 模式） | 触发时机 |
|------|------|-------------------|---------|
| `user` | 用户身份、目标、偏好、专长领域 | 始终私有 | 了解用户角色/知识时 |
| `feedback` | 对 Claude 工作方式的指导（避免/重复某行为） | 默认私有；项目惯例可团队共享 | 用户纠正或确认某种做法时 |
| `project` | 项目进行中的目标、Bug、Incident、决策（不可从代码推导） | 强偏向团队共享 | 了解"谁在做什么/为什么/截止何时"时 |
| `reference` | 外部系统的位置指针（Linear 项目、Grafana 看板等） | 通常团队共享 | 了解外部资源用途时 |

**明确不存储的内容**（代码可推导的内容）：
- 代码模式、架构、文件路径、项目结构
- Git 历史（`git log/blame` 是权威来源）
- 调试方案/修复食谱（fix 在代码里，commit message 有上下文）
- CLAUDE.md 中已记录的内容
- 短暂任务细节（当前进行中的工作、临时状态）

**内存文件格式**（YAML frontmatter + Markdown body）：
```markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user, feedback, project, reference}}
---

{{memory content — feedback/project 类型结构：规则/事实 + Why: + How to apply:}}
```

---

## 二、中期内存（compact / 上下文压缩）

### 4. 自动压缩触发条件

**文件**：`services/compact/autoCompact.ts`

**阈值计算链**：

```
effectiveContextWindow = modelContextWindow(model) - min(maxOutput, 20_000)
                         ↑ 20K 是 p99.99 的摘要输出 token 数（17,387）的安全边界

autoCompactThreshold = effectiveContextWindow - 13_000（AUTOCOMPACT_BUFFER_TOKENS）

CLAUDE_AUTOCOMPACT_PCT_OVERRIDE → 可按百分比覆盖（测试用）
CLAUDE_CODE_AUTO_COMPACT_WINDOW → 可覆盖 contextWindow 上限
```

**触发逻辑**（`shouldAutoCompact()`）：
1. 排除 querySource 为 `session_memory` 或 `compact` 的递归调用（避免死锁）
2. 排除 `isAutoCompactEnabled() === false`（可通过 `DISABLE_AUTO_COMPACT` 或 settings 关闭）
3. 排除 context collapse 模式已开启（两个系统会竞争同一问题）
4. 计算 `tokenCountWithEstimation(messages) - snipTokensFreed`
5. 若 token 数 >= autoCompactThreshold → 返回 true

**熔断器（circuit breaker）**：3 次连续失败后停止尝试（避免卡死的会话无限耗费 API 调用）。

---

### 5. 哪些消息被压缩，哪些被保留

**默认行为（全量 compact）**：
- 所有消息都传给 LLM 生成摘要
- 压缩后消息历史清空，替换为：`[boundaryMarker, summaryMessage, ...attachments, ...hookResults]`
- 图片块在送往压缩 API 前被剔除（`stripImagesFromMessages()`），替换为 `[image]` 文字标记

**session memory compact（实验性，先于标准 compact 尝试）**：
- `trySessionMemoryCompaction()` 可保留一部分最近消息（suffix-preserving）
- 保留段信息写入 `compact boundary.compactMetadata.preservedSegment`

**post-compact 重注入**：
- 读过的文件（最多 5 个，每个最多 5000 token）
- 已调用的技能内容（最多 25K token）
- Plan 文件
- Deferred tools delta、agent listing delta、MCP instructions delta

---

### 6. 压缩摘要 prompt

**文件**：`services/compact/prompt.ts`

**基础结构**（`BASE_COMPACT_PROMPT`）：
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
[NO_TOOLS_PREAMBLE — 防止模型在唯一 turn 里浪费一次工具调用]

Your task is to create a detailed summary of the conversation so far...

Before providing your final summary, wrap your analysis in <analysis> tags...
[DETAILED_ANALYSIS_INSTRUCTION — 让模型先做草稿，提升摘要质量]

Your summary should include the following sections:
1. Primary Request and Intent       ← 用户诉求（完整保留）
2. Key Technical Concepts           ← 技术术语/框架
3. Files and Code Sections          ← 文件路径 + 完整代码片段
4. Errors and fixes                 ← 错误 + 修复方法 + 用户反馈
5. Problem Solving                  ← 已解决问题 / 进行中的排查
6. All user messages                ← 全部用户消息（非工具结果）
7. Pending Tasks                    ← 待办任务
8. Current Work                     ← 最近在做什么（含文件名+代码）
9. Optional Next Step               ← 下一步（必须与最近用户请求一致）
```

**三种 prompt 变体**：
- `getCompactPrompt()`：全量压缩（BASE_COMPACT_PROMPT）
- `getPartialCompactPrompt(direction='from')`：部分压缩，从某消息往后（PARTIAL_COMPACT_PROMPT）
- `getPartialCompactPrompt(direction='up_to')`：部分压缩，到某消息为止（PARTIAL_COMPACT_UP_TO_PROMPT）

**后处理**（`formatCompactSummary()`）：
- 剥离 `<analysis>...</analysis>` 草稿块（纯质量辅助，不进入上下文）
- 提取 `<summary>...</summary>` 内容，加上 `Summary:` 标头

---

### 7. 压缩后消息历史结构变化

**压缩前**：
```
[user_0, assistant_0, user_1, assistant_1, ..., user_N, assistant_N]
                       ↑ 完整对话历史，O(N) 条消息
```

**`compactConversation()` 执行流程**：
```
1. 调用 forked agent（streamCompactSummary），传入全部消息
2. 获得摘要文本 summary（已通过 formatCompactSummary 清洗）
3. 创建 boundaryMarker（SystemCompactBoundaryMessage）
4. 创建 summaryMessages（UserMessage，isCompactSummary=true）
5. 收集 postCompactFileAttachments（文件、技能、plan、deferred tools 等）
6. 返回 CompactionResult
```

**压缩后消息数组（buildPostCompactMessages 结果）**：
```
[
  boundaryMarker,          // SystemCompactBoundaryMessage (subtype='compact_boundary')
  ...summaryMessages,      // UserMessage（摘要内容）
  ...messagesToKeep,       // 可选：保留的近期消息（partial/session-memory compact）
  ...attachments,          // AttachmentMessage（文件快照、技能等）
  ...hookResults,          // HookResultMessage（SessionStart hook 输出）
]
```

**REPL 侧消息切片**：
- `getMessagesAfterCompactBoundary()` 扫描到最后一个 compact boundary，只取 boundary 之后的消息送 API
- boundary 本身是 system message，`normalizeMessagesForAPI()` 会过滤掉它

---

### 8. SDKCompactBoundaryMessage / SystemCompactBoundaryMessage

**文件**：`utils/messages.ts`（`createCompactBoundaryMessage()`）

```typescript
{
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  isMeta: false,
  timestamp: string,
  uuid: UUID,
  level: 'info',
  compactMetadata: {
    trigger: 'manual' | 'auto',
    preTokens: number,               // 压缩前 token 数
    lastPreCompactMessageUuid: UUID, // 最后一条被压缩的消息 UUID
    userContext?: string,            // 用户自定义压缩指令
    messagesSummarized?: number,
    preCompactDiscoveredTools?: string[], // 压缩前已加载的 deferred tools
    preservedSegment?: {             // session-memory compact 时保留段的指针
      headUuid: UUID,
      anchorUuid: UUID,
      tailUuid: UUID,
    },
  }
}
```

**作用**：
1. **消息历史切片标记**：`getMessagesAfterCompactBoundary()` 用它找到"从哪里开始"，只把 boundary 之后的消息发给 API
2. **JSONL 恢复优化**：`loadTranscriptFile()` 加载大文件时跳过 boundary 之前的所有内容，只解析后半段（`readTranscriptForLoad()`），显著降低 OOM 风险（151MB 文件从 ~316MB RSS 降至 ~155MB）
3. **元数据锚点**：`preservedSegment` 用于 session-memory compact 场景的消息重链接

---

## 三、短期内存（session messages / sessionStorage）

### 9. 存储路径与格式

**路径计算**（`getTranscriptPath()`，`utils/sessionStorage.ts`）：
```
<projectsDir>/<sanitized(originalCwd)>/<sessionId>.jsonl
```
其中：
- `projectsDir = ~/.claude/projects/`
- `sanitized(cwd)`：原始工作目录经 sanitizePath 处理后的字符串
- `sessionId`：UUID，每次启动新会话生成

**子代理 transcript**（`getAgentTranscriptPath()`）：
```
<projectDir>/<sessionId>/subagents/[<subdir>/]agent-<agentId>.jsonl
```

**格式**：JSONL（每行一个完整 JSON 对象，换行分隔）

**链式结构**：每条消息有 `uuid` 和 `parentUuid` 字段，形成有向无环图（DAG）；分叉操作会产生多个叶节点，`buildConversationChain()` 通过 `leafUuids` 和逆向 parentUuid 遍历重建主链。

**写入方式**：实时 append-only；每条新消息通过 `fsAppendFile` 追加到文件末尾，不重写整个文件。

**消息类型分类**：
- **TranscriptMessage**（持久化）：`user | assistant | attachment | system`
- **Progress message**（不持久化）：UI 只读的进度推送，不写 JSONL

---

### 10. 会话恢复（`loadTranscriptFile()`）

**文件**：`utils/sessionStorage.ts` line 3472

**恢复流程**：

```
loadTranscriptFile(filePath)
  │
  ├─ [大文件优化] size > SKIP_PRECOMPACT_THRESHOLD:
  │    ├─ readTranscriptForLoad()：字节级扫描，找最后一个 compact boundary
  │    │   → 只读取 boundary 之后的字节（buf = postBoundaryBuf）
  │    │   → 如果有截断，通过 scanPreBoundaryMetadata() 回捞 session 级元数据
  │    │      （custom title、tag、mode、pr-link 等）
  │    └─ hasPreservedSegment：标记是否有保留段（需要特殊重链接）
  │
  ├─ [小文件] 直接 parseJSONL 完整内容
  │
  ├─ 逐行解析 Entry：
  │    ├─ isTranscriptMessage → 放入 messages Map（uuid → TranscriptMessage）
  │    ├─ isLegacyProgressEntry → 跳过（老版本历史兼容）
  │    ├─ 'summary' → summaries Map
  │    ├─ 'custom-title' → customTitles Map
  │    └─ 其他元数据 entry → 对应 Map
  │
  └─ 返回：{ messages, summaries, ..., leafUuids }
```

**使用侧**（`loadMessages()`，line 2289 附近）：
1. 调用 `loadTranscriptFile()` 得到 messages Map
2. 调用 `buildConversationChain()` 从叶节点逆向 parentUuid 重建有序消息链
3. 将链式消息恢复为 `Message[]`，交给 REPL/App state

---

## 四、自动记忆提取（extractMemories）

### 11. 触发时机

**文件**：`services/extractMemories/extractMemories.ts`

**触发路径**：
```
对话结束 → handleStopHooks() → executeExtractMemories()（fire-and-forget）
```

具体是：**每次主 agent 产生最终响应（无工具调用）时**（即一个 query loop 完成时），通过 `handleStopHooks` in `stopHooks.ts` 触发。

**执行条件（所有都要满足）**：
- feature gate `tengu_passport_quail` 开启（GrowthBook 控制）
- `isAutoMemoryEnabled() === true`
- 非 remote mode
- 非子代理调用（`context.toolUseContext.agentId === undefined`）

**互斥逻辑**：
- 若主 agent 本轮已向 memory 路径写过文件（`hasMemoryWritesSince()`），跳过提取，只推进游标
- 若上一次提取仍在进行中，新请求被"stash"（存储为 `pendingContext`），当前轮结束后执行 trailing run
- 节流控制（实验性，`tengu_bramble_lintel`）：可配置每 N 轮只触发一次

**游标机制**：`lastMemoryMessageUuid` 记录上次处理到的消息 UUID。每次提取只处理 cursor 之后的新消息（`countModelVisibleMessagesSince()`），成功后推进游标。

**关闭顺序**：`drainPendingExtraction()` 在 `print.ts` 输出响应后、进程 shutdown 前调用，确保正在进行的提取能完成（超时 60s）。

---

### 12. 提取算法与 prompt

**文件**：`services/extractMemories/prompts.ts`

**Prompt 结构**（`buildExtractAutoOnlyPrompt()`）：

```
opener:
  "You are now acting as the memory extraction subagent. Analyze the most
   recent ~{newMessageCount} messages above..."

Available tools: Read, Grep, Glob, read-only Bash, Edit/Write（仅限 memory 目录）

Turn budget hint:
  "Turn 1 — 并行发出所有需要更新的文件的 Read 调用
   Turn 2 — 并行发出所有 Write/Edit 调用
   不要跨轮交叉读写"

约束：
  "MUST only use content from the last ~N messages.
   Do not verify by grepping source files."

已有记忆清单（existingMemories manifest）：
  防止重复写入，先对比再决定新建还是更新

Types of memory: [TYPES_SECTION_INDIVIDUAL]

What NOT to save: [WHAT_NOT_TO_SAVE_SECTION]

How to save memories:
  Step 1: 写 topic 文件（带 frontmatter）
  Step 2: 在 MEMORY.md 中添加一行索引指针
```

**Fork 模式**：`runForkedAgent()`，共享父对话的 prompt cache（`cacheSafeParams`），最多 5 轮对话，`querySource='extract_memories'`，`skipTranscript=true`（不记录到 transcript 避免竞争）。

**写入路径**：提取 agent 通过 Write/Edit 工具将 topic 文件写到 `getAutoMemPath()` 目录。完成后通过 `appendSystemMessage?.()` 向用户展示"已保存 X 条记忆"的 system message。

**权限沙箱**（`createAutoMemCanUseTool()`）：
- Read/Grep/Glob：无限制
- Bash：只允许只读命令（`ls/find/cat/stat` 等）
- Edit/Write：只允许写入 memory 目录内路径
- 其他一切（MCP、Agent、写权限 Bash）：拒绝

---

## 必答问题总结

| # | 问题 | 答案摘要 |
|---|------|---------|
| 1 | memory files 路径 | `~/.claude/projects/<sanitized-git-root>/memory/`；Git root 为键（worktree 共享），可被 env var 或 settings 覆盖 |
| 2 | `loadMemoryPrompt()` 逻辑 | 按优先级（KAIROS > TEAMMEM > auto only > disabled）选 builder，返回文字指令拼入 system prompt；MEMORY.md 内容通过 claudemd.ts 注入 user context |
| 3 | MemoryType 四类型 | user / feedback / project / reference，各有不同范围和触发时机 |
| 4 | 自动压缩触发条件 | `tokenCount >= modelContextWindow - max_output_reserved - 13,000`；可通过 env var 按百分比覆盖 |
| 5 | 哪些消息被压缩 | 全量（默认）；session-memory compact 可保留最近消息；图片先替换为 `[image]` 标记 |
| 6 | 压缩摘要 prompt | 9 个固定章节，先写 `<analysis>` 草稿再写 `<summary>`；草稿被 `formatCompactSummary()` 剥离 |
| 7 | 消息历史结构变化 | 全部历史 → `[boundaryMarker, summaryMsg, ...attachments, ...hookResults]` |
| 8 | `SystemCompactBoundaryMessage` | subtype='compact_boundary'，用于消息切片 / 大文件跳过加载 / 恢复时重链接；元数据含 trigger、preTokens、preservedSegment |
| 9 | 会话消息历史路径与格式 | `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`；JSONL，parentUuid 链 |
| 10 | 会话恢复 | `loadTranscriptFile()` 大文件跳过 boundary 前内容 → `parseJSONL` → `buildConversationChain()` 重建有序消息链 |
| 11 | `extractMemories` 触发时机 | 每个 query loop 的 stop hook（主 agent 最终响应后），异步 fire-and-forget |
| 12 | 提取算法 | forked agent + 专用 prompt（仅处理最新 N 条消息），Write/Edit 写 topic 文件，两步法：topic 文件 + MEMORY.md 索引 |

---

## 模式卡片 #9：分层内存架构

**问题**：Agent 如何在对话轮次间、会话间保持连贯的「记忆」，同时不让所有信息都堆进 context window？

**方案（三层分离实现）**：

1. **短期（session messages）**
   - 存储：`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`（append-only JSONL）
   - 持久化：每条消息实时 append，parentUuid 形成 DAG 链，支持分叉和多叶节点
   - 恢复：`loadTranscriptFile()` → `buildConversationChain()` → 重建有序列表
   - 生命周期：单次会话范围内，可通过 `--resume` 跨进程恢复

2. **中期（compact 摘要）**
   - 触发：token 使用量超过阈值（模型 context window - 20K 输出预留 - 13K 缓冲）
   - 生成：forked agent 共享 prompt cache，调用 LLM 生成 9 章节结构化摘要
   - 存储：压缩后的摘要作为 UserMessage 写回 JSONL，`SystemCompactBoundaryMessage` 作为切片标记
   - 恢复：加载时只读取 boundary 后的内容，大幅降低内存占用

3. **长期（memory files）**
   - 存储：`~/.claude/projects/<sanitized-git-root>/memory/*.md`（每条记忆一个文件 + MEMORY.md 索引）
   - 写入：主 agent 显式写 OR 每轮结束后 extractMemories 后台子代理自动提取
   - 加载：`loadMemoryPrompt()` 在 system prompt 中注入操作指令；MEMORY.md 索引注入 user context；topic 文件按需 Read

**关键洞察**：
- 不同时间尺度需要不同策略：秒级内的工具调用用 in-memory state，分钟级的对话流用 JSONL 持久化，小时/天级的跨会话知识用结构化记忆文件
- Compact 摘要并不是"内存"——它是上下文管理（降低 token 使用），而 memory files 才是真正的跨会话知识
- Git root 而非 CWD 作为记忆目录键，使 worktree 切换场景下记忆不会孤立

**权衡**：

| 决策 | 优点 | 代价 |
|------|------|------|
| append-only JSONL | 简单、崩溃安全、可前向读 | 文件无限增长；大文件需要 skip 优化 |
| parentUuid 链而非有序数组 | 支持分叉/合并 | 加载需重建拓扑 |
| memory files 用独立文件 | 颗粒度细，可单独更新/删除 | 需要 MEMORY.md 作为索引导航 |
| extractMemories 用 fork agent | 共享 prompt cache，零额外 context window 成本 | 轻微延迟（但异步，不阻塞响应） |

---

## 模式卡片 #10：上下文压缩触发与摘要注入

**问题**：Context window 有限（200K token），如何在长对话中不丢失重要信息？

**方案（基于 autoCompact.ts + compact.ts）**：

**阈值触发**：
```
每次 query loop 结束后检查：tokenCountWithEstimation(messages) >= threshold
threshold = contextWindow - reserved_for_output(20K) - buffer(13K)
```

**执行流程**：
```
shouldAutoCompact() → true
  ↓
trySessionMemoryCompaction()（实验性，尝试保留最近消息）
  ↓（若不适用）
compactConversation()
  1. executePreCompactHooks()（外部系统可注入自定义指令）
  2. forked agent with NO_TOOLS_PREAMBLE + getCompactPrompt() → 生成摘要
     （prompt-too-long 时循环截头重试，最多 3 次）
  3. stripImagesFromMessages()（压缩前去除图片）
  4. 生成 CompactionResult:
     { boundaryMarker, summaryMessages, attachments, hookResults }
  5. REPL 将旧消息替换为 CompactionResult 的内容
  6. 写 boundary marker 到 JSONL（持久化）
  7. executePostCompactHooks() / processSessionStartHooks()
```

**关键设计决策：为什么用 LLM 生成摘要而不是硬截断？**

硬截断有两个致命问题：
1. **信息丢失不可控**：截断最老的消息可能丢掉关键的用户原始意图（"我想要 X"）或已确认的设计决策
2. **任务状态断裂**：当前工作"Current Work"可能依赖几轮前建立的上下文

LLM 摘要可以：
- 跨时间段提炼关键信息（Primary Request + Pending Tasks + Current Work）
- 将全部用户消息明确列出（保持意图追踪）
- 在 9 章节结构中保留代码片段和错误修复路径

代价：摘要本身需要一次完整 API 调用（tokens ≈ 原来的 context 大小），但通过 prompt cache 共享将实际增量 API 成本降到很低（实验数据：forked path 节省 ~99%+ cache miss）。

**权衡**：

| 决策 | 优点 | 代价 |
|------|------|------|
| LLM 摘要而非硬截断 | 保留语义连贯性和任务状态 | 压缩本身有 API 延迟和 token 成本 |
| 熔断器（3 次失败停止） | 防止不可恢复的会话无限浪费 API 调用 | 用户需手动干预才能继续 |
| `<analysis>` 草稿块 | 提升摘要质量（chain-of-thought） | 多用约 10-15% 的输出 token |
| 压缩前去除图片 | 避免摘要 API 本身 prompt-too-long | 摘要中图片变成 `[image]` 占位符 |
| 摘要注入为 UserMessage | 保持 user/assistant 角色交替规范 | 语义上略显奇怪（user 发送了自己的历史） |
| 完整 transcript 路径写入摘要 | 用户可从压缩摘要跳回原始记录查细节 | 依赖文件系统可访问 |

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `memdir/paths.ts` | 内存路径解析、`getAutoMemPath()`、路径验证与安全检查 |
| `memdir/memdir.ts` | `loadMemoryPrompt()`、`buildMemoryLines()`、`MEMORY.md` 截断保护 |
| `memdir/memoryTypes.ts` | 四类型分类定义、各类型的触发时机和使用指南文本 |
| `services/compact/autoCompact.ts` | 阈值计算、`shouldAutoCompact()`、熔断器、`autoCompactIfNeeded()` |
| `services/compact/compact.ts` | `compactConversation()`、消息截断重试、`CompactionResult` 类型 |
| `services/compact/prompt.ts` | 三种 compact prompt 变体、`formatCompactSummary()` |
| `services/extractMemories/extractMemories.ts` | 异步提取逻辑、游标管理、权限沙箱 |
| `services/extractMemories/prompts.ts` | 提取 agent 的 prompt 构建（auto-only / combined 两版） |
| `utils/sessionStorage.ts` | JSONL 路径计算、`loadTranscriptFile()`、大文件 compact-skip 优化 |
| `utils/messages.ts` | `createCompactBoundaryMessage()`、`getMessagesAfterCompactBoundary()` |
