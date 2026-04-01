---
---
# 模式卡片 #9：分层记忆架构

**来源子系统**：上下文与记忆管理（Memory）
**Claude Code 关键文件**：`src/memdir/memdir.ts`，`src/utils/sessionStorage.ts`，`src/services/extractMemories/extractMemories.ts`

---

## 问题

Agent 如何在对话轮次间、会话间保持连贯的「记忆」，同时不让所有信息都堆进 context window？不同时间尺度的信息需要不同的存储和检索策略。

## 方案

三层分离实现，每层对应不同的时间尺度：

**层 1：短期（session messages）**
- 存储：`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`（append-only JSONL）
- 持久化：每条消息实时 append，`parentUuid` 形成 DAG 链，支持分叉和多叶节点
- 恢复：`loadTranscriptFile()` → `buildConversationChain()` → 重建有序列表
- 生命周期：单次会话范围内，可通过 `--resume` 跨进程恢复

**层 2：中期（compact 摘要）**
- 触发：token 使用量超过阈值（模型 context window - 20K 输出预留 - 13K 缓冲）
- 生成：forked agent 共享 prompt cache，调用 LLM 生成 9 章节结构化摘要
- 存储：压缩后的摘要作为 UserMessage 写回 JSONL，`SystemCompactBoundaryMessage` 作为切片标记
- 恢复：加载时只读取 boundary 后的内容，大幅降低内存占用

**层 3：长期（memory files）**
- 存储：`~/.claude/projects/<sanitized-git-root>/memory/*.md`（每条记忆一个文件 + `MEMORY.md` 索引）
- 写入：主 agent 显式写 OR 每轮结束后 `extractMemories` 后台子代理自动提取
- 加载：`loadMemoryPrompt()` 在 system prompt 中注入操作指令；`MEMORY.md` 索引注入 user context；topic 文件按需 Read

## 关键设计决策

1. **三层对应三种时间尺度**：秒级内的工具调用用 in-memory state，分钟级的对话流用 JSONL 持久化，小时/天级的跨会话知识用结构化记忆文件。不同尺度的信息有根本不同的访问模式和存储需求，强行统一会导致各场景都不够优。

2. **Git root 而非 CWD 作为记忆目录键**：worktree 切换场景下，不同 worktree 的 CWD 不同但 git root 相同，使用 git root 保证记忆在 worktree 切换时不会孤立。

3. **Compact 摘要不是"内存"**：它是上下文管理（降低 token 使用），而 memory files 才是真正的跨会话知识。两者职责不同：compact 保证当前对话能继续，memory 保证跨会话知识积累。

4. **extractMemories 用 fork agent**：共享父对话的 prompt cache（`cacheSafeParams`），零额外 context window 成本，且权限沙箱严格限制——Edit/Write 只允许写入 memory 目录内路径，MCP 和 Agent 工具完全拒绝。

## 适用条件

- 需要跨会话保持用户偏好、项目知识等长期信息
- 对话可能超出 context window 限制（长时间 agentic 任务）
- 需要在不同 worktree 或不同会话间共享项目知识

## 权衡

**优点：**
- 层次清晰，各层职责单一，不相互干扰
- append-only JSONL 简单、崩溃安全、可前向读
- extractMemories 异步 fire-and-forget，不阻塞主响应
- 权限沙箱保护，记忆子 agent 无法破坏项目文件

**缺点/局限：**

| 决策 | 优点 | 代价 |
|------|------|------|
| append-only JSONL | 简单、崩溃安全 | 文件无限增长；大文件需 skip 优化 |
| parentUuid 链而非有序数组 | 支持分叉/合并 | 加载需重建拓扑 |
| memory files 用独立文件 | 颗粒度细，可单独更新/删除 | 需要 MEMORY.md 作为索引导航 |
| extractMemories 用 fork agent | 共享 prompt cache，零额外 context window 成本 | 轻微延迟（但异步，不阻塞响应） |

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
