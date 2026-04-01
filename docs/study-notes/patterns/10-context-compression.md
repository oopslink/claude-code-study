---
---
# 模式卡片 #10：上下文压缩触发与摘要注入

**来源子系统**：上下文与内存管理（Memory）
**Claude Code 关键文件**：`src/services/compact/autoCompact.ts`，`src/services/compact/compact.ts`，`src/services/compact/prompt.ts`

---

## 问题

Context window 有限（200K token），如何在长对话中不丢失重要信息？硬截断会丢失关键的用户原始意图和已确认的设计决策。

## 方案

基于阈值触发的 LLM 摘要压缩：

**阈值触发**（`autoCompact.ts`，函数 `shouldAutoCompact`）：
```
每次 query loop 结束后检查：
tokenCountWithEstimation(messages) >= threshold
threshold = contextWindow - reserved_for_output(20K) - buffer(13K)
```

**执行流程**（`compact.ts`，函数 `compactConversation`）：
```
shouldAutoCompact() → true
  ↓
trySessionMemoryCompaction()（实验性，尝试保留最近消息）
  ↓（若不适用）
compactConversation()
  1. executePreCompactHooks()（外部系统可注入自定义指令）
  2. stripImagesFromMessages()（压缩前去除图片，避免 prompt-too-long）
  3. forked agent with NO_TOOLS_PREAMBLE + getCompactPrompt() → 生成摘要
     （prompt-too-long 时循环截头重试，最多 3 次）
  4. 生成 CompactionResult: { boundaryMarker, summaryMessages, attachments, hookResults }
  5. REPL 将旧消息替换为 CompactionResult 的内容
  6. 写 boundary marker 到 JSONL（持久化）
  7. executePostCompactHooks() / processSessionStartHooks()
```

**摘要 prompt 结构**（`prompt.ts`，函数 `getCompactPrompt`）：

9 个固定章节，先写 `<analysis>` 草稿（chain-of-thought）再写 `<summary>`。草稿被 `formatCompactSummary()` 剥离，只保留正文：
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem solving approach
6. All user requests（全部用户消息列表，保持意图追踪）
7. Pending Tasks
8. Current Work
9. Optional Next Steps

## 关键设计决策

1. **为什么用 LLM 摘要而不是硬截断？**
   硬截断有两个致命问题：信息丢失不可控（可能丢掉关键的用户原始意图或已确认的设计决策）；任务状态断裂（当前工作可能依赖几轮前建立的上下文）。LLM 摘要可以跨时间段提炼关键信息，在 9 章节结构中保留代码片段和错误修复路径。代价：摘要本身需要一次 API 调用，但通过 prompt cache 共享将实际增量 API 成本降到很低。

2. **熔断器（3 次失败停止）**：防止不可恢复的会话无限浪费 API 调用。如果压缩本身多次失败，停止自动压缩，用户需手动干预。

3. **`<analysis>` 草稿块**：提升摘要质量（chain-of-thought），让模型先分析再总结。多用约 10-15% 的输出 token，但摘要质量显著提升。

4. **摘要注入为 UserMessage**：保持 user/assistant 角色交替规范。语义上略显奇怪（user 发送了自己的历史），但这是 API 格式的最佳适配。

## 适用条件

- 对话需要超过模型 context window 的长度（复杂的 agentic 任务）
- 需要在压缩后保持任务状态连贯性
- 愿意接受压缩时的 API 延迟换取后续对话的可用性

## 权衡

**优点：**
- 保留语义连贯性和任务状态，不丢失关键意图
- 9 章节结构化摘要覆盖全面
- 压缩后继续工作无需用户干预
- Prompt cache 共享大幅降低摘要 API 成本

**缺点/局限：**
- 压缩本身有 API 延迟和 token 成本
- 熔断器触发时用户需手动干预才能继续
- 压缩中图片变成 `[image]` 占位符，细节丢失
- 摘要注入为 UserMessage 语义略显奇怪
- 需要访问完整 transcript 路径，依赖文件系统可访问

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
