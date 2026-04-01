---
---
# 模式卡片 #5：Coordinator-Worker 模式

**来源子系统**：多智能体架构（Multi-Agent）
**Claude Code 关键文件**：`src/coordinatorMode.ts`，`src/tasks/LocalAgentTask/`，`src/tools/AgentTool/`

---

## 问题

如何将大任务分解给多个并行 agent 执行，并聚合结果，同时避免 coordinator 自身执行具体操作带来的混乱？

## 方案

Coordinator 通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 激活，接收专用 system prompt（`getCoordinatorSystemPrompt()`）：

**工具集严格限定**：Coordinator 只拥有 `{AgentTool, TaskStopTool, SendMessageTool, SyntheticOutputTool}`，无法直接执行文件操作或 bash 命令。

**Worker 工具集注入**：通过 `getCoordinatorUserContext()` 将 worker 的工具集信息注入 coordinator 的 user context，让 coordinator 知道 worker 能做什么，可以在 prompt 中指导 worker 使用特定工具。

**工作流四阶段**：Research → Synthesis（coordinator 亲自完成）→ Implementation → Verification。Synthesis 阶段由 coordinator 自己完成，禁止写"基于你的发现"这类懒性委派。

**完全异步消息流**：
```
Coordinator
    |-- AgentTool(prompt) ──> Worker (LocalAgentTask)
    |                              |
    |                         runAgent() / enqueuePendingNotification()
    |<── user-role <task-notification> XML ────────|
    |
    |-- SendMessageTool(to=agentId, msg) ─────> 同一 Worker（复用上下文）
```

**继续 vs 新建 Worker 的决策矩阵**：
- 研究过的文件需要编辑 → `SendMessageTool` continue（worker 已有文件在 context）
- 研究范围宽但实现范围窄 → `AgentTool` 新建（避免携带噪声上下文）
- 修复已有 worker 的失败 → continue（worker 有错误上下文）
- 独立验证 → 新建（验证者应有新鲜视角）

## 关键设计决策

1. **工具过滤即角色定义**：coordinator 只有编排工具，不能直接执行。这不是技术限制，而是角色职责的代码化表达：
   - **防止 coordinator 分心**：禁止直接工具调用迫使它把所有工作委派出去，自己专注于全局视角
   - **强制并行化**：多个独立的 AgentTool 调用可以在同一消息中并发发出，是并行化的天然触发点
   - **安全隔离**：coordinator 无法直接修改文件系统，即使 coordinator 产生幻觉，也无法直接造成代码破坏

2. **Synthesis 阶段必须由 coordinator 亲自完成**：禁止把信息合成委派给 worker，确保 coordinator 真正理解各 worker 的发现，而不仅仅是转发。

## 适用条件

- 任务可以分解为多个相对独立的子任务，且子任务之间不需要实时通信
- 需要并行加速（同时启动多个 Research worker）
- coordinator 的主要价值在于任务分解和结果整合，而非具体执行

## 权衡

**优点：**
- 并行研究/实现大幅提速
- 清晰的任务归属（谁做了什么有 task-id 可追溯）
- coordinator 上下文专注于高层决策
- 可以停止错误方向的 worker（TaskStopTool）

**缺点/局限：**
- coordinator 轮次增加（每次等 worker 回报才能继续）
- worker 不能看到彼此的工作（只能通过 coordinator 中转）
- 长并行 session 会积累大量 task-notification 消息，增加 context 长度
- worker 之间无法直接协调（无 peer-to-peer 通信）

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
