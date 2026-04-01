# 模式卡片 #3：进度上报与 UI 解耦

**来源子系统**：工具系统（Tool System）
**Claude Code 关键文件**：`src/tools/Tool.ts`（L384），`src/tools/AgentTool/AgentTool.tsx`

---

## 问题

工具执行时（如 AgentTool 运行子 agent、BashTool 执行长命令），如何将中间进度实时推送到 UI，且工具逻辑不依赖任何 UI 框架（如 React/Ink）？

## 方案

**`onProgress?: ToolCallProgress<P>` 回调注入**（`Tool.ts:384`）：框架在调用 `tool.call()` 时注入进度回调，工具内部调用 `onProgress({ toolUseID, data: P })` 上报进度。工具不持有任何 UI 引用。

**`ProgressMessage` 中间格式**：`onProgress` 的数据先存入消息历史（`ProgressMessage<ToolProgressData>`），UI 组件从消息历史中读取，实现数据与视图的时序解耦。

**`renderToolUseProgressMessage(progressMessages, opts) → ReactNode`**：每个工具自定义如何将进度消息渲染为 React 节点。进度数据是纯数据，渲染逻辑封装在工具的渲染方法中。

**AgentTool 的具体实现**：子 agent 每产出一条消息，`runAgent` generator yield 该消息，AgentTool 的 while 循环收到后调用 `onProgress({ data: { type: 'agent_progress', message } })`，UI 的 `renderToolUseProgressMessage` 将其渲染为可折叠的消息列表。

## 关键设计决策

**onProgress 回调 vs 其他方案的比较：**

| 方案 | 分析 |
|------|------|
| **onProgress 回调（现方案）** | 函数注入，工具不持有框架引用；类型参数 `P` 限定进度类型；无需额外基础设施；与 async/await 自然组合 |
| EventEmitter | 工具需要继承 EventEmitter 类；事件名是字符串（类型不安全）；需要手动清理监听器（内存泄漏风险） |
| RxJS Observable | 强大但是重量级依赖；与现有 async/await 代码混用摩擦大 |
| AsyncGenerator（直接） | `runAgent` 内部用了 AsyncGenerator；但在工具接口层用 Generator 会破坏 `call()` 返回 `Promise<ToolResult>` 的统一签名 |

onProgress 回调是最轻量的解耦方案：工具代码保持纯函数风格，框架通过闭包注入 UI 更新逻辑，双方通过 `ToolProgressData` 类型契约通信。

## 适用条件

- 执行时间超过秒级的工具
- 有自然的中间状态（每条命令输出、每条子 agent 消息）
- 工具逻辑希望与 UI 框架完全解耦
- 需要在非 UI 上下文（SDK、测试）中复用工具实现

## 权衡

**优点：**
- 工具本身无 UI 依赖，可在非 UI 上下文（SDK、测试）中使用，进度回调直接 noop
- 类型安全——`P extends ToolProgressData` 让每个工具的进度格式有精确类型
- 轻量，无需额外依赖库

**缺点/局限：**
- 进度数据存入消息历史再读出，有一层间接性，增加调试复杂度
- `onProgress` 是可选的（`?`），工具无法强制框架提供进度通道
- 渲染逻辑（`renderToolUseProgressMessage`）仍然耦合在 Tool 接口里，只是把 React 依赖延迟到了渲染时

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
