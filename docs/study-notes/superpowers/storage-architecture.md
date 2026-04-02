# Claude Code 存储架构完全指南

> 日期：2026-04-02
> 覆盖主题：设置系统、指令文件、Skills、会话 Transcript、History、Memory、文件备份、运行时状态、缓存、安全存储、Worktree

---

## 核心概念

Claude Code 的所有持久化数据都围绕一个根目录展开：

```
~/.claude/     默认根目录，可通过 CLAUDE_CONFIG_DIR 环境变量覆盖
```

整个存储体系由**三套同构的四层结构**组成——设置系统、CLAUDE.md 指令体系、Skills 体系——三套都遵循同一个优先级模型：

```
Managed（企业管控）→ User（用户全局）→ Project（项目共享）→ Local（本地私有）
```

后加载的层优先级更高，后者可以覆盖前者。

---

## 一、认证与全局配置

| 文件 | 内容 | 来源 |
|------|------|------|
| `~/.claude/.credentials.json` | OAuth token、API key | `auth.ts:1323` |
| `~/.claude/.config.json` | 全局 app 运行时配置（env vars 覆盖层） | `env.ts:18` |

---

## 二、设置系统（五层合并）

**核心文件**：`src/utils/settings/settings.ts`、`src/utils/settings/constants.ts`

五个 source 按优先级从低到高依次合并：

```
userSettings    → ~/.claude/settings.json
projectSettings → <repo>/.claude/settings.json        ← 可提交 git
localSettings   → <repo>/.claude/settings.local.json  ← gitignored（放 secrets）
flagSettings    → --settings 启动参数（内存，不落盘）
policySettings  → 企业 MDM / managed-settings.json    ← 不可被用户覆盖
```

`policySettings` 自身也是多源合并（优先级从高到低）：
1. 远程 managed settings（API 下发）
2. 平台 MDM（macOS plist / Windows HKLM）
3. 文件：`managed-settings.json` + drop-in 目录（`managed-settings.d/*.json`，按文件名排序合并）
4. HKCU（Windows 用户注册表）

**Managed 根目录**（平台相关）：
```
macOS:   /Library/Application Support/ClaudeCode/
Linux:   /etc/claude-code/
Windows: C:\Program Files\ClaudeCode\
```

`localSettings` 是 gitignored 的，worktree 创建时会 **copy**（不是 symlink）到 worktree 的 `.claude/` 目录，实现真正隔离。

---

## 三、指令文件系统（CLAUDE.md 体系）

**核心文件**：`src/utils/claudemd.ts`

文件按以下顺序加载，**越晚加载优先级越高**（模型更关注后出现的内容）：

### 加载顺序

```
1. Managed CLAUDE.md       /etc/claude-code/CLAUDE.md
2. Managed rules           /etc/claude-code/.claude/rules/*.md
3. User CLAUDE.md          ~/.claude/CLAUDE.md
4. User rules              ~/.claude/rules/*.md
5. Project CLAUDE.md       <每级目录>/CLAUDE.md            ← 从 root 到 cwd 逐级
6. Project .claude CLAUDE  <每级目录>/.claude/CLAUDE.md
7. Project rules           <每级目录>/.claude/rules/*.md
8. Local CLAUDE.md         <每级目录>/CLAUDE.local.md      ← gitignored
9. memdir MEMORY.md        ~/.claude/projects/<cwd>/memory/MEMORY.md（若启用）
10. Team MEMORY.md         ~/.claude/projects/<cwd>/memory/team/MEMORY.md（若启用）
```

Project 和 Local 文件在每一级目录都会检查（从文件系统根目录走到 cwd），离 cwd 越近的目录优先级越高。

### 关键特性

**`@include` 指令**：CLAUDE.md 内可用 `@path` 引入其他文件。
```
@./relative/path
@~/home/path
@/absolute/path
```
循环引用会被检测并跳过，不存在的文件静默忽略。外部 include（项目目录外）需用户明确授权。

**嵌套 Worktree 去重**：当 Claude 在 `.claude/worktrees/<slug>/` 内运行时，向上遍历会经过 worktree 根和主仓库根，Project 类型文件只从 worktree 自身的 checkout 读取，避免重复加载。

### 完整路径汇总

```
/etc/claude-code/
├── CLAUDE.md              # Managed 全局指令
└── .claude/rules/*.md     # Managed rules

~/.claude/
├── CLAUDE.md              # User 全局指令
└── rules/*.md             # User rules

<repo>/
├── CLAUDE.md              # Project 指令（提交 git）
├── CLAUDE.local.md        # Local 指令（gitignored）
└── .claude/
    ├── CLAUDE.md          # Project 指令（提交 git）
    └── rules/*.md         # Project rules（提交 git）
```

---

## 四、Skills 与 Commands

**核心文件**：`src/skills/loadSkillsDir.ts`、`src/utils/skills/skillChangeDetector.ts`

### 目录结构

```
/etc/claude-code/.claude/skills/<name>/SKILL.md   # Managed
~/.claude/skills/<name>/SKILL.md                  # User
<repo>/.claude/skills/<name>/SKILL.md             # Project（向上遍历到 home）

# Legacy commands（仍支持）
/etc/claude-code/.claude/commands/
~/.claude/commands/
<repo>/.claude/commands/
```

Skills 目录格式：必须是 `<skill-name>/SKILL.md`（子目录），不支持散落的单 `.md` 文件。

### 热加载

`skillChangeDetector.ts` 用 **chokidar** 监听目录变化：
- 检测到变更后 debounce **300ms** 再重载，防止批量变更（如 git pull）触发雪崩
- Bun 下改用 **stat() 轮询**（2s 间隔），绕开 Bun FSWatcher 死锁 bug（oven-sh/bun#27469）
- 重载后清除 memoize 缓存，通知所有监听者

---

## 五、会话 Transcript（JSONL）

**核心文件**：`src/utils/sessionStorage.ts`

```
~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl
```

`sanitized-cwd` 是工作目录路径把非字母数字字符替换成 `-` 后的字符串，确保唯一性。

### 文件内容

每行一条 `Entry`，类型包括：
- `user` / `assistant` 消息
- `tool_use` / `tool_result`
- `context-collapse-snapshot` / `context-collapse-commit`（压缩边界）
- `file-history-snapshot`（文件快照，用于 undo）
- `worktree-state`（worktree 进入/退出状态，用于 `--resume`）
- `attribution-snapshot`（commit 归因）

### Worktree Session

Worktree 会话用 `getSessionProjectDir()`（而非按 cwd 派生），transcript 存在 worktree 路径对应的 project 目录下，不污染主仓库历史。

`worktree-state` entry 记录完整的恢复信息：
```typescript
{
  originalCwd, worktreePath, worktreeName, worktreeBranch,
  originalBranch, originalHeadCommit, sessionId, tmuxSessionName
}
```
退出 worktree 时写 `null`，`--resume` 时读取此字段恢复上下文。

---

## 六、输入历史

**核心文件**：`src/history.ts`、`src/utils/pasteStore.ts`

```
~/.claude/history.jsonl          # 全局输入历史（所有项目共享，追加写入）
~/.claude/paste-cache/<hash>.txt # 大文本粘贴（内容寻址）
```

### 两级存储策略

| 粘贴内容大小 | 存储方式 |
|------------|---------|
| ≤ 1024 字节 | 内联在 history.jsonl 条目内 |
| > 1024 字节 | SHA256 前 16 位作为文件名存入 paste-cache，history.jsonl 只存 hash |

图片不存入 history.jsonl，单独走 `image-cache/` 路径。

### 写入机制

- **追加写入**（`appendFile`），不覆盖，天然支持并发
- **lockfile 保护**：多进程同时写入时通过文件锁串行化，防止条目交叉
- **内存缓冲**：写入先进 `pendingEntries`，异步 flush，Esc 中断时可从缓冲中撤销（`removeLastFromHistory`）
- 进程退出时 cleanup hook 确保未 flush 的条目写盘

---

## 七、Memory 系统（memdir）

**核心文件**：`src/memdir/memdir.ts`、`src/memdir/paths.ts`

```
~/.claude/projects/<cwd>/memory/
├── MEMORY.md                    # 索引文件（上限 200 行 / 25KB）
├── user_role.md                 # 各类 topic 文件
├── feedback_testing.md
└── team/                        # Team memory（TEAMMEM 功能，可选）
    ├── MEMORY.md
    └── ...
```

### 四类型分类法

| 类型 | 用途 |
|------|------|
| `user` | 用户角色、偏好、知识背景 |
| `feedback` | 对 Claude 行为的修正与肯定 |
| `project` | 项目背景、目标、决策 |
| `reference` | 外部系统指针（Linear、Grafana 等） |

### 关键约束

- `MEMORY.md` 是**索引**，不是内容——每行一个指针，超过 200 行或 25KB 时截断并附 warning
- 各 topic 文件带 YAML frontmatter（`name`/`description`/`type`）
- KAIROS 模式（长期 assistant session）改为 append-only 日志写法：`logs/YYYY/MM/YYYY-MM-DD.md`，由 nightly `/dream` 蒸馏成 MEMORY.md

---

## 八、文件编辑历史（Undo）

**核心文件**：`src/utils/fileHistory.ts`

```
~/.claude/file-history/<session-id>/<fileNameHash>@v<version>
```

每次 Claude 编辑文件**之前**，先把当前文件内容备份到此目录。文件名格式：`{sha256(filePath)[:16]}@v{version}`。

`--resume` 时，旧 session 的所有备份文件会迁移（hardlink）到新 session 目录，确保 undo 在跨 session 恢复后仍然有效。

---

## 九、Plans（计划模式）

**核心文件**：`src/utils/plans.ts`

```
~/.claude/plans/<slug>.md               # 主对话计划
~/.claude/plans/<slug>-agent-<id>.md    # 子 agent 计划
```

如果项目 `settings.json` 配置了 `plansDir`，则存到项目内指定路径。`/clear` 时重置 slug 生成新文件，不覆盖旧计划。

---

## 十、运行时状态

### 并发会话注册

```
~/.claude/sessions/<pid>.json
```

每个运行中的 Claude 进程写一个 PID 文件，记录 `sessionId`、`kind`（`interactive`/`bg`/`daemon`）、`status`（`busy`/`idle`/`waiting`）等。`claude ps` 从这里读取。进程退出时自动清理；崩溃后下次启动扫描并删除僵尸文件。

### 图片缓存

```
~/.claude/image-cache/<session-id>/<filename>
```

用户粘贴的图片按 session 隔离存储，支持时间 based 清理。

### Bridge 上传（IDE 集成）

```
~/.claude/uploads/<session-id>/
```

IDE 插件通过 bridge 协议发来的附件，按 session 隔离。

### Shell 快照

```
~/.claude/shell-snapshots/
```

Bash 工具跨调用保持 shell 环境状态（工作目录、环境变量等）的序列化快照。

---

## 十一、缓存与诊断

| 路径 | 内容 |
|------|------|
| `~/.claude/cache/changelog.md` | 发布日志缓存（releaseNotes.ts） |
| `~/.claude/cache/` | model capabilities 缓存 |
| `~/.claude/stats-cache.json` | token 用量统计缓存 |
| `~/.claude/debug/<session>.txt` | `--debug` 模式调试日志（按 session） |
| `~/.claude/startup-perf/<session>.txt` | 启动耗时剖析数据 |
| `~/.claude/traces/` | Perfetto 性能追踪数据 |

---

## 十二、安全存储（凭证）

**核心文件**：`src/utils/secureStorage/index.ts`

```
macOS:   Keychain → 失败时降级到 plainTextStorage
Linux:   plainTextStorage（TODO: libsecret）
Windows: plainTextStorage
```

Fallback 策略：macOS 优先写 Keychain，读/写失败自动降级，不阻断启动流程。

---

## 十三、Worktree 存储

**核心文件**：`src/utils/worktree.ts`

```
<repo>/
└── .claude/
    └── worktrees/
        └── <slug>/              # git worktree 实体
            └── .claude/
                └── settings.local.json   # 从主仓库 copy 过来
```

嵌套 slug（`user/feature`）展平为 `user+feature`，避免 git ref D/F 冲突。

### 创建时做了什么

| 操作 | 内容 | 原因 |
|------|------|------|
| `copyFile` | `settings.local.json` | 含 secrets，不能 symlink（共享状态） |
| `git config core.hooksPath` | 指向主仓库 `.husky/` 或 `.git/hooks/` | worktree 没有自己的 hooks |
| `symlinkDirectories` | `node_modules` 等（按配置） | 避免磁盘膨胀 |
| `copyWorktreeIncludeFiles` | `.worktreeinclude` 匹配的 gitignored 文件 | 把 `.env` 等本地配置带入 worktree |

**`.worktreeinclude`**：项目根目录下的文件，使用 gitignore 语法声明哪些 gitignored 文件要复制进 worktree。

---

## 十四、其他文件

| 路径 | 内容 |
|------|------|
| `~/.claude/keybindings.json` | 自定义键绑定 |
| `~/.claude/ide/` | IDE 集成 IPC socket |
| `~/.claude/plugins/` | 已安装插件 |
| `~/.claude/backups/` | 设置变更前的配置备份 |
| `~/.claude/jobs/` | 后台任务 |
| `~/.claude/tasks/` | Tasks 工具持久化 |
| `~/.claude/chrome/` | Claude in Chrome 集成 |
| `~/.claude/local/` | 本地安装器文件 |
| `~/.claude/computer-use.lock` | computer-use 工具互斥锁 |
| `~/.claude/.update.lock` | 自动更新互斥锁 |
| `~/.claude/.npm-cache-cleanup` | 一次性清理 marker |
| `~/.claude/.version-cleanup` | 版本清理 marker |

XDG 缓存目录（`{platform-cache}/claude-cli/<cwd>/`）另有：`errors/`、`messages/`、`mcp-logs-<server>/`。

---

## 完整目录树

```
/etc/claude-code/                   ← Managed 根（Linux）
├── CLAUDE.md
├── managed-settings.json
├── managed-settings.d/*.json
└── .claude/
    ├── rules/*.md
    └── skills/<name>/SKILL.md

~/.claude/                          ← User 根
├── .credentials.json               # OAuth/API key
├── .config.json                    # 全局 app 配置
├── .update.lock                    # 自动更新互斥
├── .npm-cache-cleanup              # 清理 marker
├── .version-cleanup                # 清理 marker
├── settings.json                   # User 设置
├── CLAUDE.md                       # User 指令
├── rules/*.md                      # User rules
├── skills/<name>/SKILL.md          # User skills
├── commands/                       # User legacy commands
├── keybindings.json                # 键绑定
├── history.jsonl                   # 全局输入历史
├── paste-cache/<hash>.txt          # 大文本粘贴（内容寻址）
├── image-cache/<session>/          # 图片粘贴
├── uploads/<session>/              # IDE bridge 上传
├── file-history/<session>/         # 文件编辑备份（undo）
├── plans/<slug>.md                 # EnterPlanMode 计划
├── sessions/<pid>.json             # 并发进程注册
├── stats-cache.json                # token 用量缓存
├── cache/                          # changelog、model capabilities
├── debug/<session>.txt             # 调试日志
├── startup-perf/<session>.txt      # 启动性能数据
├── traces/                         # Perfetto 追踪
├── shell-snapshots/                # Shell 环境快照
├── ide/                            # IDE IPC socket
├── plugins/                        # 已安装插件
├── backups/                        # 设置备份
├── jobs/                           # 后台任务
├── tasks/                          # Tasks 持久化
├── computer-use.lock               # computer-use 互斥
├── chrome/                         # Claude in Chrome
├── local/                          # 本地安装器
└── projects/<sanitized-cwd>/       # 每个工作目录一个子目录
    ├── <session-id>.jsonl          # 会话 transcript
    └── memory/                     # memdir 持久化记忆
        ├── MEMORY.md               # 索引（200行/25KB上限）
        ├── <topic>.md              # topic 文件
        └── team/                   # 团队共享记忆（TEAMMEM）
            └── MEMORY.md

<repo>/                             # 项目根目录
├── CLAUDE.md                       # Project 指令（提交 git）
├── CLAUDE.local.md                 # Local 指令（gitignored）
├── .worktreeinclude                # 声明哪些 gitignored 文件复制进 worktree
└── .claude/
    ├── settings.json               # Project 设置（提交 git）
    ├── settings.local.json         # Local 设置（gitignored）
    ├── CLAUDE.md                   # Project 指令（提交 git）
    ├── rules/*.md                  # Project rules
    ├── skills/<name>/SKILL.md      # Project skills
    └── worktrees/<slug>/           # git worktree 实体
        └── .claude/
            └── settings.local.json # 从主仓库 copy

{platform-cache}/claude-cli/<cwd>/  # XDG 缓存（平台相关）
├── errors/
├── messages/
└── mcp-logs-<server>/
```

---

## 设计规律总结

| 规律 | 体现 |
|------|------|
| **三套同构四层** | 设置、CLAUDE.md、Skills 都是 Managed→User→Project→Local |
| **追加写入** | `history.jsonl`、session `.jsonl`——避免随机写，支持并发 |
| **内容寻址** | `paste-cache/`——SHA256 命名，天然去重，覆写安全 |
| **lockfile** | `history.jsonl` 写入时加锁，防多进程交叉写 |
| **两级粘贴** | 小内联大外存，history 文件不膨胀 |
| **session 隔离** | `image-cache/`、`file-history/`、`uploads/` 都按 session 子目录隔离 |
| **Worktree copy 不 symlink** | secrets 类文件（`settings.local.json`）必须 copy，大无状态目录（`node_modules`）才 symlink |
| **XDG 规范** | cache 和 config 目录分离，平台路径由 `env-paths` 统一管理 |
