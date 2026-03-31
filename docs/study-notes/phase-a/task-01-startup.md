# Task 1：启动流程与运行模式

## 启动并行化

### 问题 1：系统启动时哪几件事是并行执行的？

Claude Code 在启动过程中有多处并行化设计，分布在两个层次：

#### 层次一：模块加载阶段的并行（main.tsx 顶部，第 12-20 行）

文件最开头连续触发三件事（注释明确说明这些必须在所有其他 import 之前运行）：

1. **`profileCheckpoint('main_tsx_entry')`**（第 12 行）
   在任何模块开始加载前打下时间戳，目的是测量 import 阶段耗时。

2. **`startMdmRawRead()`**（第 16 行）
   启动 MDM（Mobile Device Management）子进程（macOS 上是 `plutil`，Windows 上是 `reg query`）。这些子进程读取企业管控策略，耗时约数十 ms。提前触发使其与后续 ~135ms 的 import 加载时间重叠。

3. **`startKeychainPrefetch()`**（第 20 行）
   同时触发两个 macOS keychain 读取（OAuth token + 旧版 API key）。注释说明：如果串行执行，`isRemoteManagedSettingsEligible()` 内部会通过同步 spawn 顺序读取这两个值，耗时约 65ms；并行化后这个开销近乎消失。

**为什么并行而不串行？** 这三件事都是 I/O 密集型（磁盘读取、子进程启动），与 JS 模块加载（CPU 密集型）相互独立，可以完全重叠。子进程在 135ms 的模块加载期间就已完成，等到 preAction hook 调用 `ensureKeychainPrefetchCompleted()` 时几乎不需要等待。

#### 层次二：action handler 中的 setup + commands 并行（main.tsx 第 1927-1929 行）

```typescript
const setupPromise = setup(preSetupCwd, ...)
const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)
const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd)
```

- **`setup()`** 主要耗时在 `startUdsMessaging()`（socket 绑定，约 20ms）——不是磁盘密集型，不与文件读取竞争。
- **`getCommands()`** 从磁盘扫描命令文件。
- **`getAgentDefinitionsWithOverrides()`** 扫描 agent 定义文件。

三者同时启动，最后由 `await setupPromise` 串行等待（因为 commands 需要知道最终 cwd，若 --worktree 模式下 setup 会 chdir，所以 worktree 启用时禁用此并行，见第 1928 行注释）。

#### 层次三：preAction hook 中的并行等待（第 914 行）

```typescript
await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
```

等待层次一启动的两个后台任务完成。

---

### 问题 2：`profileCheckpoint` 出现了几次？它的作用是什么？

在 `main.tsx` 中共出现 **42 次**，setup.ts 中再出现 **3 次**（共 45 次）。

主要出现位置（main.tsx）：

| 出现位置 | checkpoint 名称 |
|---------|----------------|
| 第 12 行 | `main_tsx_entry` |
| 第 209 行 | `main_tsx_imports_loaded` |
| 第 503/515 行 | `eagerLoadSettings_start/end` |
| 第 586/607/849/853/855 行 | `main_*` 系列 |
| 第 885/903 行 | `run_*` 系列 |
| 第 908-966 行 | `preAction_*` 系列（共 7 个） |
| 第 1007/1862/1878/1904/1936/2031 行 | `action_*` 系列 |
| 第 2402/2560/2728/2824/2828 行 | MCP/plugin 阶段 |

**作用（见 `src/utils/startupProfiler.ts`）：**

1. **性能监控**：使用 `performance.mark()` 记录各阶段时间戳，计算相邻 checkpoint 之间的耗时。
2. **分级输出**：
   - 详细模式（`CLAUDE_CODE_PROFILE_STARTUP=1`）：输出完整时间线报告 + 内存快照，写入 `~/.claude/startup-perf/<session-id>.txt`。
   - 统计采样模式（ant 用户 100%，外部用户 0.5%）：将各阶段耗时上报到 Statsig（`logEvent('tengu_startup_perf', ...)`）。
3. **阶段定义**（`PHASE_DEFINITIONS`，startupProfiler.ts 第 49-54 行）：
   - `import_time`：cli_entry → main_tsx_imports_loaded
   - `init_time`：init_function_start → init_function_end
   - `settings_time`：eagerLoadSettings_start → eagerLoadSettings_end
   - `total_time`：cli_entry → main_after_run

**setup.ts 中出现 3 次**（第 306 行 `setup_before_prefetch`，第 381 行 `setup_after_prefetch` 及其他位置），用于标记预取前后及相关阶段的时间点。

---

## Feature Flags

### 问题 3：`feature('COORDINATOR_MODE')` 控制的是哪个模块？

**文件：** `main.tsx` 第 76 行

```typescript
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js')
  : null;
```

控制的是 `src/coordinator/coordinatorMode.js` 模块。

**这个模块做什么：** 协调器模式（Coordinator Mode）是一种特殊的工具过滤机制，用于多智能体协作场景中的"协调器"角色。当 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量设置时（main.tsx 第 1872 行），对 headless 路径的工具列表执行 `applyCoordinatorToolFilter()`，从工具集中移除不适合协调器角色使用的工具。协调器专注于任务分派和结果汇总，而不直接执行低层次操作。

---

### 问题 4：`feature('KAIROS')` 控制的是哪个模块？

**文件：** `main.tsx` 第 80-81 行

```typescript
const assistantModule = feature('KAIROS')
  ? require('./assistant/index.js') as typeof import('./assistant/index.js')
  : null;
const kairosGate = feature('KAIROS')
  ? require('./assistant/gate.js') as typeof import('./assistant/gate.js')
  : null;
```

控制 `src/assistant/index.js` 和 `src/assistant/gate.js` 两个模块。

**KAIROS 对应的功能——"assistant mode"（助理模式）：**
这是一种特殊的交互模式，让 Claude Code 作为"助理"嵌入到用户的工作流中（类似 Cursor/VSCode 中的常驻侧边栏 AI）。代码中明确标记 KAIROS 为 "assistant mode"（main.tsx 第 78 行注释）。从代码行为来看：

- `assistant: true`（设置在 `.claude/settings.json` 中）+ GrowthBook gate `tengu_kairos` 开启时激活。
- 激活后强制开启 `brief` 模式（简洁回应），设置 `kairosActive=true`（第 1081 行），并预初始化一个 agent team（第 1086 行）。
- 支持 `claude assistant [sessionId]` 子命令来 attach 到正在运行的 bridge session（第 4335 行）。
- `_pendingAssistantChat` 对象（第 559-562 行）追踪命令行中 `claude assistant` 子命令的参数。

---

### 问题 5：条件 require 与普通 import 有何不同？

这两个 feature flag 使用的都是**条件式同步 `require()`**，而非顶级 `import`：

```typescript
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js')
  : null;
```

**特别之处：**

1. **Dead code elimination（死代码消除）**：注释明确说明目的是 "Dead code elimination"。`feature()` 来自 `bun:bundle`，是构建期常量——Bun 打包时若 `COORDINATOR_MODE` 为 false，整个 `require(...)` 分支会被静态裁剪，模块代码完全不进入产物。这对于只发布给特定用户的功能（如 ant 内部功能）可以减小二进制体积。

2. **与普通 `import` 的对比：**
   - 普通 `import` 是**静态声明**，无论如何都会加载模块（包括其所有依赖），无法按条件剔除。
   - `require()` 是**运行时调用**，配合 `feature()` 的构建期求值，可实现真正的条件编译效果。
   - 副作用：普通 import 在模块图解析阶段执行 side effects；条件 require 只在运行时分支成立时才执行。

3. **类型安全的妥协**：使用 `as typeof import(...)` 保留 TypeScript 类型信息（类型级 import 不影响运行时），同时保持 `require()` 的运行时条件性——这是一种兼顾类型安全和 tree-shaking 的常见模式。

---

## 运行模式

### 问题 6：系统有哪几种运行模式？

| 模式 | 触发条件（CLI 参数 / 环境变量） | 入口函数 | 所在位置 |
|------|-------------------------------|----------|---------|
| **Interactive（REPL）模式** | 默认（无 `-p`，stdout 是 TTY） | `launchRepl()` → 渲染 `<App><REPL/></App>` | main.tsx 约第 3134、3176、3242、3338、3487、3733、3798 行（多处调用，对应不同的 resume/SSH/assistant 路径） |
| **Headless（--print / -p）模式** | `-p` 或 `--print`，或 `--sdk-url`，或 `!process.stdout.isTTY` | `runHeadless()` from `src/cli/print.js` | main.tsx 第 2826-2829 行 |
| **SDK 模式** | `CLAUDE_CODE_ENTRYPOINT=sdk-ts/sdk-py/sdk-cli`，或通过 `--sdk-url` 传入远程 SDK URL | `runHeadless()` + `stream-json` 格式（自动设置） | main.tsx 第 1236-1252 行设置格式，然后走 headless 路径 |
| **Bridge（remote-control）模式** | `claude remote-control` 子命令（或 `--rc`），或 `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` | `bridgeMain()` from `src/bridge/bridgeMain.js` | main.tsx 第 4328-4331 行（commander action），以及 cli.tsx 快速路径 |
| **MCP server 模式** | `claude mcp serve` | MCP 服务注册 handler | main.tsx 中 `initializeEntrypoint` 第 527 行设置 `CLAUDE_CODE_ENTRYPOINT=mcp` |
| **Init-only 模式** | `--init-only` | 执行 Setup 和 SessionStart:startup hooks 后退出 | main.tsx 第 801 行检测，作为非交互模式处理 |
| **SSH Remote 模式** | `claude ssh <host>` | 交互式 REPL，但底层连接是 SSH 会话 | main.tsx 第 706-794 行解析 SSH 参数，约第 3487 行处理 SSH 的 `launchRepl` 调用 |
| **Assistant（KAIROS）模式** | `claude assistant [sessionId]`，或 settings 中 `assistant: true` + GrowthBook gate | 交互式 REPL + bridge session attach | main.tsx 第 685-698 行解析 assistant 参数，第 1048-1088 行初始化 |

**运行模式判定逻辑（main.tsx 第 800-803 行）：**

```typescript
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
const hasInitOnlyFlag = cliArgs.includes('--init-only')
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))
const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY
```

这些条件变量先在 main 函数顶部统一计算（共同判定逻辑），然后在各个 action handler 的入口处读取判定结果，决定走 `runHeadless()`（非交互）还是 `launchRepl()`（交互式 REPL）的入口。最终通过 `isNonInteractive` 这一条件分岔，路由到不同的执行引擎。

---

## 初始化流程

### 问题 7：`src/setup.ts` 设置了哪些全局状态？

`setup()` 函数（setup.ts）设置的全局状态：

| 全局状态 | 设置方式 | 位置 |
|---------|---------|------|
| **cwd（当前工作目录）** | `setCwd(cwd)`（来自 `src/utils/Shell.js`） | setup.ts 第 161 行；worktree 模式下会再次更新（第 272 行） |
| **originalCwd** | `setOriginalCwd(getCwd())` | setup.ts 第 273 行（仅 worktree 模式） |
| **projectRoot** | `setProjectRoot(getCwd())` | setup.ts 第 277 行（仅 worktree 模式） |
| **session ID** | `switchSession(asSessionId(customSessionId))` | setup.ts 第 83 行（当 customSessionId 提供时） |
| **UDS messaging socket** | `startUdsMessaging(socketPath)` | setup.ts 第 97-100 行（feature('UDS_INBOX') 时） |
| **hooks 配置快照** | `captureHooksConfigSnapshot()` | setup.ts 第 166 行 |
| **fileChanged watcher** | `initializeFileChangedWatcher(cwd)` | setup.ts 第 172 行 |
| **session memory** | `initSessionMemory()` | setup.ts 第 294 行（非 bare 模式） |
| **context collapse** | `initContextCollapse()` | setup.ts 第 298 行（feature('CONTEXT_COLLAPSE') 时） |
| **analytics sinks** | `initSinks()` | setup.ts 第 371 行 |
| **api key（预取）** | `prefetchApiKeyFromApiKeyHelperIfSafe()` | setup.ts 第 380 行 |

此外，`src/main.tsx` 的 action handler 在调用 `setup()` 前/后还设置：

- `setIsInteractive(isInteractive)` 第 812 行
- `setClientType(clientType)` 第 834 行
- `setSessionSource('remote-control')` 第 847 行
- `setKairosActive(true)` 第 1081 行（KAIROS 激活时）
- `setSessionBypassPermissionsMode()` 第 1398 行

---

### 问题 8：配置文件从哪里加载？查找顺序是什么？

**配置来源（`src/utils/settings/constants.ts` 第 7-22 行，后定义的优先级更高）：**

| 优先级 | 来源名称 | 文件路径 |
|--------|---------|---------|
| 1（最低） | `userSettings` | `~/.claude/settings.json`（全局用户配置） |
| 2 | `projectSettings` | `<project>/.claude/settings.json`（项目共享配置，可提交） |
| 3 | `localSettings` | `<project>/.claude/settings.local.json`（项目本地配置，gitignored） |
| 4 | `flagSettings` | `--settings <file-or-json>` CLI 参数指定的文件或内联 JSON |
| 5（最高） | `policySettings` | 企业管控设置，来源有优先级子序列（见下方） |

**`policySettings` 的内部优先级（settings.ts 第 322-395 行，同样后者覆盖前者）：**
1. 文件：`<managed-dir>/managed-settings.json` + `managed-settings.d/*.json`（需要 admin 权限写入）
2. 注册表/plist：macOS plist 或 Windows HKLM 注册表（MDM 管控）
3. 远程：从 Anthropic API 获取的远程管理设置（最高优先级）

**特殊机制：**
- `--setting-sources user,project,local` 可以显式限制加载哪些来源（init.ts 相关）。
- `flagSettings` 和 `policySettings` 始终加载，不受 `--setting-sources` 控制（constants.ts 第 163-166 行）。
- Cowork 模式下 `userSettings` 改读 `~/.claude/cowork_settings.json`（settings.ts 第 264-272 行）。
- 配置加载使用缓存（`settingsCache.ts`），`resetSettingsCache()` 可强制重新读取。

---

## 关键发现

1. **"启动热路径"的极致优化**：Claude Code 将 3 件 I/O 密集型任务（MDM 子进程、keychain 读取、模块加载）并行化到文件顶部——这 3 行代码甚至早于其他 `import` 语句执行（靠 ESM hoisting 之前的副作用时机），充分利用了约 135ms 的模块加载窗口。这种设计思路值得在其他长启动链路的 CLI 工具中借鉴。

2. **`feature()` = 编译期开关，不是运行期 if**：`bun:bundle` 的 `feature()` 在 Bun 打包时求值为常量，使得整个模块分支可被死代码消除。这解释了为什么 COORDINATOR_MODE 和 KAIROS 等功能不会增加外部发布版本的体积，同时在内部版本中完整可用。

3. **两条主干路径的分叉点**：整个运行模式的核心判断在 main.tsx 第 800-803 行，仅 4 行代码决定了后续走交互式 REPL 还是 headless 管道流。`--sdk-url` 的存在使得"SDK 模式"本质上是 headless 模式的特化，而不是独立的第三条路径。

4. **setup.ts 是 cwd 的"守门人"**：注释反复强调 `setCwd()` 必须在所有依赖 cwd 的代码之前调用（setup.ts 第 160 行注释），hook 配置必须在 `setCwd()` 之后捕获快照（第 164 行注释），worktree 的 cwd 切换必须在 commands 并行加载之前完成（main.tsx 第 1928 行注释）。这说明 cwd 是整个系统的隐式全局依赖，任何乱序都会导致 hook/plugin 加载路径错误。

5. **配置的分层覆盖模型体现了"最小特权 + 可管控"原则**：用户设置 < 项目设置 < 本地设置 < CLI 参数 < 企业管控。企业管控（policySettings）始终加载且优先级最高，但普通用户可以用 `--settings` 在不影响共享配置的前提下临时覆盖。这种设计使个人、团队、企业三种使用场景都能平滑支持。

6. **代码中确认的内部术语**：Tengu 是 Claude Code 的内部代号（在代码中用于内部分析和性能上报函数名 `logTenguInit`），KAIROS 是 "assistant mode" 的特性名（代码注释明确标记）。这两个术语出现在代码注释和函数名中，用于区分内部功能集。
