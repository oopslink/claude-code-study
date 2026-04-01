---
---
# 模式卡片 #2：Tool 接口统一抽象

**来源子系统**：工具系统（Tool System）
**Claude Code 关键文件**：`src/tools/Tool.ts`（L362, L783），`src/tools/tools.ts`

---

## 问题

如何让能力差异极大的工具（文件读取、Bash 执行、网络请求、子 agent 启动、MCP 代理）被模型以完全统一的方式调用，且能在权限系统、UI、序列化各层次无缝处理？

## 方案

**单一 `Tool<Input, Output, Progress>` 泛型接口**（`Tool.ts:362`）：类型参数让每个工具的输入/输出/进度都有精确类型，但调用框架可以用 `Tool<AnyObject, unknown>` 统一持有。接口约 40 个成员，涵盖执行、权限、API 序列化、UI 渲染、路径信息五个维度：

- **执行核心**：`call(input, ctx, onProgress) → Promise<ToolResult>`，`isEnabled()`，`isConcurrencySafe()`，`isReadOnly()`，`isDestructive()`
- **权限**：`validateInput()`，`checkPermissions()`，`preparePermissionMatcher()`
- **API 序列化**：`mapToolResultToToolResultBlockParam()`，`inputSchema`（Zod schema → JSON Schema）
- **UI 渲染**：`renderToolUseMessage()`，`renderToolResultMessage()`，`renderToolUseProgressMessage()` 等
- **路径信息**：`getPath()`，`inputsEquivalent()`

**`buildTool(def: ToolDef) → Tool` 工厂函数**（`Tool.ts:783`）：接受省略了可默认方法的 `ToolDef`，填入安全默认值后返回完整 `Tool`。所有工具通过此函数构建，保证接口完整性。默认值均为 fail-closed：`isConcurrencySafe=false`，`isReadOnly=false`，`checkPermissions=allow`。

**JSON Schema 作为 API 边界**：MCP 工具直接提供 JSON Schema，内置工具通过 Zod schema 自动转换，两种路径最终都生成标准 JSON Schema 发给 API。

## 关键设计决策

1. **`inputSchema` 用 Zod 而非纯 TypeScript 类型**：Zod 同时提供运行时校验（`tool.inputSchema.parse(input)`）、类型推断（`z.infer<Input>`）、JSON Schema 生成（发给 API）三合一。纯 TS 类型在编译后擦除，无法在运行时读取或序列化。

2. **`buildTool()` 工厂函数的默认值策略**：新工具无法遗漏关键安全方法，fail-closed 默认值保证了安全底线——即使忘记实现 `isReadOnly()`，默认返回 `false`（按破坏性工具处理），不会意外跳过权限检查。

3. **`mapToolResultToToolResultBlockParam()` 由工具自己实现**：每个工具自己知道如何将结构化输出序列化为 API `tool_result`，文本/图片/notebook 各有实现，框架无需了解内部结构。

## 适用条件

需要将异构能力（文件 I/O、进程执行、网络、子系统调用）统一暴露给模型/框架/UI 时；工具数量超过 10 个且需要统一权限管理时。

## 权衡

**优点：**
- 接口统一，框架代码（权限、序列化、UI）只需面对 `Tool` 接口，不关心实现
- `buildTool()` 的默认值保证 fail-closed，新工具无法遗漏关键安全方法
- MCP 工具与内置工具对框架完全透明，无需特殊处理路径

**缺点/局限：**
- 接口过大（约 40 个成员），实现完整工具需要大量样板代码
- 渲染方法（`renderToolUseMessage` 等）与执行逻辑耦合在同一接口，违反关注点分离
- 泛型参数增加了类型系统复杂度，框架层持有 `Tool<AnyObject, unknown>` 时丢失精确类型

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
