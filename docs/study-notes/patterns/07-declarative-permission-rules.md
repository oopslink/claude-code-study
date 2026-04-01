---
---
# 模式卡片 #7：声明式权限规则引擎

**来源子系统**：安全与沙箱（Security）
**Claude Code 关键文件**：`src/tools/BashTool/bashPermissions.ts`，`src/types/permissions.ts`，`src/utils/shell/shellRuleMatching.ts`

---

## 问题

如何让用户可配置地控制工具权限，而不需要改代码？不同项目、不同企业环境、不同使用习惯需要不同的权限策略，如何设计一个灵活且安全的规则引擎？

## 方案

基于分层 settings 的规则引擎，`ToolPermissionContext` 作为运行时规则容器。

**规则结构**：
```typescript
type PermissionRule = {
  source: PermissionRuleSource   // 规则来源（决定优先级和持久化位置）
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
}
```

**Bash 规则 `ruleContent` 语法**（由 `shellRuleMatching.ts` 解析）：
- `git status` — 精确匹配
- `git commit:*` — 前缀匹配（git commit 加任意后缀）
- `npm run *` — 通配符模式

**分层 settings 体系**（优先级从高到低）：
```
policySettings（企业管控）
  > userSettings（~/.claude/settings.json，全局用户配置）
  > projectSettings（.claude/settings.json，项目级别）
  > localSettings（.claude/settings.local.json，本地不提交）
  > flagSettings（CLI 参数 --allow-bash）
  > session（用户在会话中点"不再询问"）
```

**规则建议机制**：当命令需要用户确认时，系统自动建议合适粒度的规则：
- 稳定前缀（`git commit:*`）优于精确命令
- Heredoc 命令 → 取 heredoc 前的命令前缀作为规则
- 多行命令 → 取第一行作为前缀规则
- Shell 解释器（`bash`、`zsh`、`sudo` 等）→ 不建议过于宽泛的规则

## 关键设计决策

1. **优先级规则：`deny > ask > allow`，精确匹配 > 前缀/通配符**：
   - Deny 优先保证了安全底线——用户明确禁止的命令永远不执行
   - Ask 优先于 Allow 提供了"强制审查"的逃生通道
   - 精确匹配优先于前缀避免了宽泛规则意外覆盖精确规则

2. **Deny 规则与 Allow 规则非对称的 env-var 剥离策略**：
   - Deny 规则：使用 `stripAllLeadingEnvVars`（剥离所有环境变量），防止 `FOO=bar denied_cmd` 绕过 `Bash(denied_cmd:*)` 的 deny 规则
   - Allow 规则：只剥离安全 env var 白名单，防止 `DOCKER_HOST=evil docker ps` 自动匹配 `Bash(docker ps:*)` 规则
   - 这体现了"allow 要谨慎，deny 要彻底"的安全原则

3. **规则来源决定持久化位置**：session 规则方便但不持久；projectSettings 规则提交到 git 供团队共享；policySettings 由企业管控，用户无法覆盖。

## 适用条件

- 用户需要精细控制 AI 工具权限（既不想每次都问，也不想完全信任）
- 不同项目需要不同权限配置
- 企业环境需要统一策略管控
- 系统需要支持权限规则的渐进式学习（从每次询问到保存规则）

## 权衡

**优点：**
- 声明式配置，用户无需改代码
- 分层覆盖，从个人到企业的权限需求都能满足
- 自动建议规则降低了用户配置成本
- 规则来源透明，用户知道每条规则从哪来

**缺点/局限：**
- 规则越细越安全，但用户配置成本高
- 前缀规则复用性强，但可能意外允许危险命令（`Bash(git:*)` 允许所有 git 操作）
- session 临时规则使用方便，但无法持久化——重启后需重新确认
- deny 规则的激进 env-var 剥离可能造成意外拦截（`ANT_ENV=prod denied_cmd` 也被拦截）

---

## 在自己项目中的应用思考

**这个问题在我的项目中存在吗？**
（待填写）

**可以直接用吗？还是需要简化/调整？**
（待填写）

**可以省略的复杂度：**
（待填写）
