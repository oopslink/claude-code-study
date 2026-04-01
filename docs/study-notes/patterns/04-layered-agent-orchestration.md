# 模式卡片 #4：分层 Agent 编排

**来源子系统**：多智能体架构（Multi-Agent）
**Claude Code 关键文件**：`src/tasks/LocalAgentTask/`，`src/tasks/RemoteAgentTask/`，`src/tasks/InProcessTeammateTask/`

---

## 问题

如何根据任务特征选择合适的 agent 执行模式（本地/远程/进程内），在性能、隔离性、协作能力之间取得平衡？

## 方案

三种 Task 类型针对本质不同的需求：

**LocalAgentTask**（`src/tasks/LocalAgentTask/`）：
- 通过 `createSubagentContext()` 创建隔离的 `ToolUseContext`（克隆 readFileState，独立 AbortController，no-op setAppState）
- 调用 `runAgent()` → `query()` 在同一 JS 线程内运行完整的 agent 循环
- 结果通过 `enqueuePendingNotification()` 写入消息队列，以 XML user-role 消息形式注入父对话
- 取消：`abortController.abort()` 中断 query 循环，立即生效

**RemoteAgentTask**（`src/tasks/RemoteAgentTask/`）：
- 通过 teleport API 在 CCR 云端创建 session，本地只保存 `sessionId`
- 每秒通过 `pollRemoteSessionEvents()` 拉取增量 `SDKMessage[]`
- session metadata 写入磁盘 sidecar（`--resume` 时可恢复）
- 结果通过专用标签解析（`<remote-review>`、`<ultraplan>` 等）或 `result` 消息类型判断

**InProcessTeammateTask**（`src/tasks/InProcessTeammateTask/`）：
- 通过 `runWithTeammateContext()` 注入 `AsyncLocalStorage`，实现上下文隔离而非进程隔离
- `runInProcessTeammate()` 实现持续运行的 while 循环，idle 后等待 mailbox 消息
- 权限需求路由到 leader 的 `ToolUseConfirmQueue`，UI 显示 worker badge
- 双 AbortController：lifecycle（杀死整个 teammate）+ currentWork（打断当次工作）

## 关键设计决策

**为什么需要三种不同的 Task 类型而不是统一一种？**

三种类型解决的是本质不同的问题：
1. LocalAgentTask 是「即发即忘」后台任务，不需要长期存活，也不需要与其他 agent 协作
2. RemoteAgentTask 是「离线执行」任务，本地只是观察者；云端有独立的计算资源和网络隔离，本地崩溃不影响执行
3. InProcessTeammateTask 是「持续在场」的协作 agent，需要 idle 等待、接收 DM、请求权限审批、与团队其他成员共享任务列表

**选择标准：**
- 单次、后台、无需交互 → `local_agent`
- 超长时间、云环境、需要 CCR → `remote_agent`
- 多 agent 团队、需要持续协作、需要权限 UI → `in_process_teammate`

**结果异步化是统一机制**：无论本地还是远程，结果都通过 `enqueuePendingNotification()` 注入消息队列，父 agent 永远不「等待」子任务，而是「接收通知」。

## 适用条件

- 系统需要支持多种 agent 执行场景（单次后台任务、长时间云任务、持续协作团队）
- 父子 agent 之间需要异步通信（不阻塞父 agent 继续处理其他事务）
- 需要差异化的隔离级别（进程内隔离 vs 云端隔离）

## 权衡

**优点：**
- 各类型针对场景优化，LocalAgent 启动开销低，RemoteAgent 本地崩溃不影响
- 统一的异步通知机制，父 agent 代码不区分子任务类型
- AbortController 树结构，父 abort 自动传播给子 agent

**缺点/局限：**

| | LocalAgent | RemoteAgent | InProcessTeammate |
|--|-----------|------------|-----------------|
| 启动开销 | 低（进程内） | 高（网络+云端启动） | 低（进程内） |
| 资源占用 | 低（任务完成即释放） | 很低（本地只轮询） | 高（线程持续占用） |
| 可靠性 | 依赖本地进程存活 | 本地崩溃不影响（可 resume） | 依赖本地进程存活 |
| 协作能力 | 无（单次通知） | 无（异步通知） | 强（mailbox、任务列表、权限 UI） |

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
