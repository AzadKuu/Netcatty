# Netcatty HarmonyOS 移植 · 交接文档

> 面向接手的模型/人。所有命令都在 Windows + git-bash 下验证过。
> 仓库：`D:\workspace\Netcatty`，分支 **`feat/harmony-port`**，工作区干净。

---

## 0. 一句话现状

Netcatty（Electron + React 终端管理器）已成功跑在鸿蒙 PC（HAD-W32）上：SSH、SFTP、端口转发、托盘、下载、设置窗口都可用；**外部 CLI agent 不能在鸿蒙本地执行**（系统禁止 exec 用户区文件），所以 DSH 改成「远端 Linux 跑 `dsh --profile acp`，Netcatty 通过 SSH 驱动」，已验证端到端可用。Windows 打包版有一个待确认的启动失败（已加诊断与兜底，等一份日志确认）。

### 已经能用
- SSH 会话、多标签、SFTP 浏览与传输、端口转发、全局快捷键、托盘图标
- 下载保存（鸿蒙走系统「另存为」选择器；沙箱 `Downloads/Netcatty` 兜底）
- **DSH agent**（Settings → AI）：`ssh://user@host[:port]` 固定一台 agent 主机，任意聊天会话都能用；终端快照会注入给远端 agent
- **Catty 增强模式**（Settings → AI 开关）：计划工具 `plan_update` + 每步自检 + 工具失败「改参数重试一次」

### 已知不可用（鸿蒙限制，非 bug）
| 能力 | 原因 |
|---|---|
| 本地终端 | 端口层没有 pty；node-pty 在鸿蒙加载失败。要支持需自己写 NAPI `forkpty` |
| 插件宿主 | 鸿蒙 Node 缺 `node:sqlite` 内置模块 |
| claude/codex/cursor 等本机 CLI agent | 系统只允许 exec **系统分区**二进制，应用/用户区文件 `execve` 一律 `EPERM`/`EACCES` |
| 终端内联图片（SIXEL/Kitty/iTerm） | ArkWeb 的 V8 未编译 WebAssembly，`@xterm/addon-image` 已改为惰性加载，功能自动禁用 |
| 命令补全 fig 规格 | `scripts/sync-harmony-app.cjs` 为体积跳过 `@withfig/autocomplete` |

---

## 1. 环境与路径

| 项 | 值 |
|---|---|
| 仓库 | `D:\workspace\Netcatty`（分支 `feat/harmony-port`） |
| 鸿蒙工程 | `harmony/`（两个 module：`web_engine` 运行时 HAR + `electron` 壳 HAP） |
| 包名 | `com.AzadKuu.NetCatty`，应用内版本 `1.1.90` |
| DevEco Studio | `D:/Program Files/Huawei/DevEco Studio` |
| DevEco node | `D:/Program Files/Huawei/DevEco Studio/tools/node/node.exe`（v24.x） |
| hvigor | `D:/Program Files/Huawei/DevEco Studio/tools/hvigor/bin/hvigorw.js` |
| SDK | `DEVECO_SDK_HOME="D:\\Program Files\\Huawei\\DevEco Studio\\sdk"` |
| hdc | 已在 PATH（3.2.x） |
| 签名材料 | `C:\Users\30923\.ohos\config\default_harmony_*.{p12,cer,p7b}`（`harmony/build-profile.json5` 里 `signingConfig: default`） |
| 应用 payload | `harmony/web_engine/src/main/resources/resfile/resources/app/`（由同步脚本生成，勿手改） |

> ⚠️ **不要用** `D:/Program Files/Huawei/command-line-tools/sdk`：那份 `default/openharmony` 只有 `ets`，会报 `hvigor ERROR: SDK component missing`。

---

## 2. 连鸿蒙设备

设备是鸿蒙 PC（型号 `HAD-W32`，API 26）。无线调试端口每次重启/重连都可能变。

```bash
# git-bash 里必须先做这两行，否则 hdc file recv 的 /data/... 会被 MSYS 改写成 C:/...
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# 端口在设备上：设置 → 开发者选项 → 无线调试（形如 192.168.x.x:45673）
hdc tconn 192.168.124.26:45673
hdc list targets          # 应显示 192.168.124.26:45673
hdc -t 192.168.124.26:45673 shell "param get const.product.model"   # HAD-W32
```

设备会**间歇掉线**（`hdc list targets` 变 `[Empty]`）。恢复套路：

```bash
hdc kill; hdc start; sleep 2; hdc tconn <ip>:<port>; hdc list targets
```

之后所有命令都带 `-t <ip>:<port>`；地址太长可以先 `export T=<ip>:<port>`。

常用设备操作：

```bash
hdc -t $T shell "pidof com.AzadKuu.NetCatty"                       # 进程在不在
hdc -t $T shell "aa force-stop com.AzadKuu.NetCatty"               # 杀进程
hdc -t $T shell "aa start -a EntryAbility -b com.AzadKuu.NetCatty" # 启动（不会自动切前台）
hdc -t $T shell "bm dump -a" | grep -i netcatty                    # 是否已安装
```

---

## 3. 编译 → 安装 → 启动 → 截图（鸿蒙）

### 3.1 只在 electron/ 主进程侧改了代码（最常见）

```bash
cd /d/workspace/Netcatty
node scripts/sync-harmony-app.cjs --node-modules
#   → [harmony:sync] copied dist/electron/lib/domain/infrastructure
#   → refreshed 245/245 node_modules entries (42.7 MB)
#   → payload ready (version 1.1.90)
```

### 3.2 也改了渲染层（`components/`、`application/`、`infrastructure/` 等）

先构建 renderer。**必须把 TEMP 指到可写目录**，否则本机会报
`[vite:esbuild-transpile] remove ...esbuild-*: Access is denied.`：

```bash
cd /d/workspace/Netcatty
export TEMP="D:\workspace\Netcatty\.tmp-build\vite-temp" TMP="$TEMP"
npx vite build            # 约 1 分钟
node scripts/sync-harmony-app.cjs --node-modules
```

### 3.3 打 HAP（约 1 分 50 秒 ~ 2 分 40 秒）

```bash
cd /d/workspace/Netcatty/harmony
export DEVECO_SDK_HOME="D:\\Program Files\\Huawei\\DevEco Studio\\sdk"
"D:/Program Files/Huawei/DevEco Studio/tools/node/node.exe" \
  "D:/Program Files/Huawei/DevEco Studio/tools/hvigor/bin/hvigorw.js" \
  --mode module -p product=default -p buildMode=debug \
  -p module=electron@default assembleHap --no-daemon
```

产物：`harmony/electron/build/default/outputs/default/electron-default-signed.hap`（约 336 MB）。

### 3.4 安装（必须用相对路径！）

hdc 会把参数拼成「当前目录 + 参数」，传绝对路径会变成
`path:D:\workspace\Netcatty\D:/workspace/...` 而失败。

```bash
cd "/d/workspace/Netcatty/harmony/electron/build/default/outputs/default"
hdc -t $T install -r electron-default-signed.hap     # 约 30 s，输出 install bundle successfully.
hdc -t $T shell "aa start -a EntryAbility -b com.AzadKuu.NetCatty"
sleep 6 && hdc -t $T shell "pidof com.AzadKuu.NetCatty"
```

> 安装会 force-stop 应用：**正在跑的 SSH 会话会断**。设备有人在用先问一句。

### 3.5 截图

```bash
hdc -t $T shell "snapshot_display -f /data/local/tmp/s.jpeg"
hdc -t $T file recv /data/local/tmp/s.jpeg .harmony-diag/s.jpeg
# 再用 read_image 看 .harmony-diag/s.jpeg
```

`aa start` **不会把窗口抬到前台**（用户可能正停在别的应用上）。要操作界面时用 uinput：
`uinput -T -c <x> <y>` 点击、`uinput -K -t "文本"` 输入、`uinput -M -m dx dy` 移动。

---

## 4. 调试手段

### 4.1 hilog（应用日志）

```bash
hdc -t $T shell "hilog -r"                                   # 清空
hdc -t $T shell "aa force-stop com.AzadKuu.NetCatty; aa start -a EntryAbility -b com.AzadKuu.NetCatty"
hdc -t $T shell "hilog -x" > .harmony-diag/run.log           # 导出
hdc -t $T shell "hilog -x | grep -F 'Electron:' | tail -40"
```

- 主进程 `console.log` → `A00001/com.AzadKuu.NetCatty/Electron: ...`
- 渲染进程 console 已被转发（`electron/main.cjs` 里 harmony 才启用）→ `[Renderer:error] <msg> (<file>:<line>)`
- 崩栈：`appspawn_service.c:140 ... exit with signal:11` + `threadname(CrBrowserMain)`；`/data/log/faultlog` 无 root **读不到**

### 4.2 CDP 连设备主进程（最强工具）

```bash
hdc -t $T fport rm tcp:9229 tcp:9229; hdc -t $T fport tcp:9229 tcp:9229
node .harmony-diag/cdp.mjs "1+1"                     # 直接给表达式
node .harmony-diag/cdp-file.mjs .harmony-diag/xx.js --await   # 从文件读（避免 shell 转义地狱）
```

**两个必须知道的坑：**
1. 主进程 `Runtime.evaluate` 里 **`require` 过了第一次 `await` 就变 `undefined`**。脚本首行必须
   `var R = require;`，之后全用 `R(...)`。
2. 应用有 **两个窗口**：main（webContents id=1，`app://netcatty/index.html`）与 settings（id=2，`#/settings`）。
   `aiSdkAgentStream` 等 IPC 走严格 `validateSender`，只有 main 合法。取法：
   ```js
   const e = require('electron');
   const wc = require(path.join(e.app.getAppPath(), 'electron/bridges/windowManager.cjs')).getMainWindow().webContents;
   ```
   `app.getAppPath()` 在设备上是 `/data/storage/el1/bundle/electron/resources/resfile/resources/app`。

设置页是独立窗口：`window.netcatty.openSettingsWindow()`；AI 页内部是 **Radix 段标签**，`element.click()` 无效，必须派发完整指针序列：
```js
['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
  const C = t.startsWith('pointer') ? PointerEvent : MouseEvent;
  el.dispatchEvent(new C(t, { bubbles:true, cancelable:true, view:window, button:0 }));
});
```

### 4.3 设备端一些实测结论（别再重复试）

- 应用 uid `20020256`；`/data/storage/el2/base/files` 可读写（`Downloads`、`.netcatty`）
- `/data/local/tmp` 在 app 视角是 `ENOENT`（不同挂载命名空间，hdc 推不了文件给 app）
- 系统下载目录 `/storage/Users/currentUser/Download` 主进程**不能直写**（`EPERM`），只能走 picker
- 应用/用户区文件 **不能 exec**（`toybox` 复制到沙箱 chmod 755 仍 `EACCES`；`/system/bin/toybox` 可以）
- `/bin/sh`、`setsid`、`toybox`、`tty` 存在；`/bin/bash`、`/bin/script` 不存在
- ArkWeb V8 **没有 WebAssembly**（主进程 V8 也没有）
- 已申请的目录权限：`READ_WRITE_DOWNLOAD_DIRECTORY`、`READ_WRITE_DOCUMENTS_DIRECTORY`（`harmony/electron/src/main/module.json5` 的 `requestPermissions`），系统认为安装期即生效，不弹窗

---

## 5. 代码结构：哪些是移植改动

主进程侧（`electron/`）：
- `harmonyCompat.cjs` —— 平台判断（`isHarmony()` 认 `harmony|ohos|openharmony`；真机 `process.platform === "openharmony"`）、temp/下载目录、`isTerminalWorkerSupported()` 等
- `main.cjs` —— 早期 debug 日志、单实例、启动错误对话框（`showStartupError` 现在会带 `Reason:`）、渲染进程 console 转发
- `main/registerBridges.cjs` —— 桥注册；鸿蒙上 `terminalWorkerManager = null`（worker 子进程在鸿蒙 SIGTRAP，改为全部在主进程跑）
- `bridges/tempDirBridge.cjs` —— 临时目录；**现在有兜底链**：配置/系统 temp → `<userData>/Netcatty`
- `bridges/windowManager/settingsWindow.cjs` —— 设置窗口置顶脉冲（鸿蒙 400ms `setAlwaysOnTop` 后撤销）
- `bridges/globalShortcutBridge.cjs` —— 托盘；鸿蒙上 **跳过 `tray.setContextMenu(null)`**（原生层空指针会 SIGSEGV）
- `bridges/terminalBridge.cjs` —— 新增主进程侧 `requestMainInitiatedSnapshot()`
- `bridges/transferBridge.cjs` —— 下载落点 remap（鸿蒙）
- `bridges/aiBridge/` —— AI 桥；`sdk/dshAcpDriver.cjs` 是 DSH 驱动（本地 spawn + SSH 两种传输）

渲染层关键文件：
- `infrastructure/ai/cattyAgent/{systemPrompt.ts,cattyMode.ts}` —— Catty 提示词与模式
- `infrastructure/ai/harness/capabilityTools.ts` —— `createCattyPlanTool()`、`decorateToolsWithRetryGuidance()`
- `infrastructure/ai/harness/turnDrivers/cattyTurnDriver.ts` —— 按模式装配工具与提示词
- `infrastructure/ai/dshAgentHost.ts` —— `ssh://` 解析 + 自动建 SSH 会话
- `components/settings/tabs/ai/{CopilotCliCard.tsx,dshAgentHostSelection.ts,cattyModeToggle.ts}`、`SettingsAITab.tsx`

鸿蒙工程侧：
- `harmony/electron/src/main/module.json5`（权限、abilities）、`ets/entryability/EntryAbility.ets`（前台申请目录权限）
- `harmony/web_engine/src/main/ets/adapter/AppWindowAdapter.ets`（`setAlwaysOnTop` → `setWindowTopmost`）、`StatusBarManager.ets`、`FilePickerAdapter.ets`、`ProcessAdapter.ets`
- **端口层 C++ 只有 `cpp/types/`，没有源码可改**

---

## 6. 关键修复记录（避免回退）

1. **托盘崩溃（SIGSEGV, CrBrowserMain）**：`updateTrayMenu()` 在非 linux 平台 `tray.setContextMenu(null)`，鸿蒙落入该分支 → 原生空指针。已加 `isHarmony()` 提前 return。
2. **终端 worker SIGTRAP**：`utilityProcess.fork` 出的 `:NodeService` 子进程没注册 JS binding 就崩。已改为鸿蒙禁用 worker，桥在主进程跑（`NETCATTY_TERMINAL_WORKER=0` 等价）。
3. **「Terminal could not load.」**：`@xterm/addon-image` 在模块求值期实例化 WebAssembly → ArkWeb 抛 `ReferenceError: WebAssembly is not defined`，整个 TerminalLayer chunk 挂。已改 `loadInlineImageAddon()` 惰性 + `vite.config.ts` 把它从 `vendor-xterm` 里摘出。
4. **下载落点**：`harmonyCompat.remapLocalTransferTarget()` 在 `startTransfer` 准入前改道；判断用 `isHarmony(platform)`（**不是** `platform === "harmony"`）。
5. **设置窗口跑到后面**：`restoreWindowInputFocus` 原来只有 win32 做置顶脉冲。
6. **窗口创建被临时目录拖死**：`getTempDir()` 失败会冒到 `createWindow` → 弹「Failed to load the UI」。现在有兜底链 + 错误详情。

---

## 7. Windows 打包（在能联网的机器上）

前置：`node_modules` 里 node-pty / @vscode/windows-process-tree 的 gyp 已改成受 `NETCATTY_NO_SPECTRE` 控制（本机 VS2022 没装 Spectre 库）：

```bash
cd /d/workspace/Netcatty
export NETCATTY_NO_SPECTRE=1
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export TEMP="D:\workspace\Netcatty\.tmp-build\os-temp" TMP="$TEMP"

npx vite build
node scripts/sync-harmony-app.cjs --node-modules      # 仅鸿蒙需要
npx electron-builder --config electron-builder.config.cjs --win --x64 --dir --publish=never \
    --config.extraMetadata.version=1.1.90 --config.directories.output=release-fix
```

- `--dir` 出 `release-fix/win-unpacked/Netcatty.exe`（免安装，双击即用）
- 要 NSIS/portable/zip 就去掉 `--dir`（首次要下载 NSIS 等二进制，**必须挂镜像**，否则会 `Timeout awaiting 'request' for 600000ms`）
- 根 `package.json` 是 `0.0.0`，所以必须用 `--config.extraMetadata.version=1.1.90`

---

## 8. 待办（按优先级，含根因）

### 8.1 Windows 打包版「Failed to load the UI. Please relaunch Netcatty.」
**已确认的机制**（来自 `netcatty_debug.log`）：失败点永远是 `createWindow()` → `registerBridges()` → `ensureTempDir()` → `getTempDir()`，报 `EPERM ... mkdir/chmod '%TEMP%\Netcatty'`。窗口因此建不出来，只能弹那句笼统文案。

已经做的：
- `tempDirBridge.cjs`：temp 目录失败时回退到 `<userData>/Netcatty`，并逐条记录失败原因
- `main.cjs`：`showStartupError` 现在把底层错误写进对话框（`Reason: <code>: <message>`），并且 `_earlyDbgLog("[Main] Startup error dialog:", ...)` 落盘
- `main.cjs`：单实例锁失败也落盘（`[Main] single-instance lock not acquired; quitting userData=...`）

下一步（要真实机器验证）：
1. 双击 `release-fix\win-unpacked\Netcatty.exe`（SmartScreen → 更多信息 → 仍要运行；火绒要放行）
2. 若仍失败，把弹窗里的 `Reason:` 行或 `%APPDATA%\Netcatty\netcatty_debug.log` 末尾贴出来

### 8.2 DSH 在鸿蒙读不到当前终端（已挂起，task-4）
根因：`electron/bridges/aiBridge.cjs` 的 `buildExternalAgentSystemContext()` **远端分支已经写好了**（`if (remoteAgentHost) { ... }`，不再告诉 agent 用本地 `netcatty-tool-cli`），但 `electron/bridges/aiBridge/sdk/sdkStreamHandlers.cjs` 里的调用点**从来没传 `remoteAgentHost`**，于是 agent 仍收到本地 CLI 指令 → 去 `/data/storage/el1/.../netcatty-tool-cli` 报 exit 127。

改法（两处调用点）：在回合里已有 `pinnedSshAgent` 的地方加
```js
const remoteAgentHost = pinnedSshAgent ? agentCommand.trim() : undefined;
```
并传给 `buildExternalAgentSystemContext({...})` 和 `buildExternalAgentContextualPrompt({...})`。

验证脚本：`.harmony-diag/dsh-realturn.js`（会读 localStorage 里的 agent 配置 + 当前活动标签，用真实标签跑一轮）。判据：远端 agent 不再提 `netcatty-tool-cli`，而是引用 host 注入的终端快照。

### 8.3 其它
- `git push` 上次因网络失败（`SSL_ERROR_SYSCALL`），本地领先远端 2 个提交：`03eabbfde`、`5309fb5c5`
- 若要让鸿蒙支持**本地**终端：需要给端口写一个 NAPI `forkpty`（`harmony/web_engine/src/main/cpp` 只有 types，C++ 无源码 → 工作量很大）
- 若要让插件宿主可用：需要给鸿蒙 Node 补 `node:sqlite`（或改成可选依赖）

---

## 9. 坑清单（血泪版）

| 现象 | 原因 / 解法 |
|---|---|
| `hdc file recv /data/...` 报路径不存在 | MSYS 路径改写 → 先 `export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` |
| `hdc install <绝对路径>` 失败 | hdc 会拼 cwd → `cd` 到产物目录用相对名 |
| `hvigor ERROR: SDK component missing` | 用了 command-line-tools 的 sdk → 换 DevEco 的 |
| `vite build` 报 `esbuild-*: Access is denied` | TEMP 不可写 → `TEMP=...\.tmp-build\vite-temp` |
| 应用启动即退、无日志 | 本机 shell 泄漏了 `ELECTRON_RUN_AS_NODE=1` → `env -u ELECTRON_RUN_AS_NODE` |
| `timeout` / `nohup` 在 git-bash 不可用 | 用 `run_in_background` 的 job，或 `(cmd > log 2>&1 &)` |
| 后台命令被 shell 超时杀掉 | win_bash 默认 300 s，长任务显式给 `timeoutMs` 或后台 job |
| `tasklist //FI "..."` 报错 | git-bash 把 `//` 转义坏了 → 用 `tasklist \| grep -i netcatty` |
| Radix 标签/菜单点了没反应 | 需要完整指针序列（见 4.2） |
| CDP eval 里 `require` 突然 undefined | 过了 `await` 就丢 → 首行 `var R = require;` |
| `Unauthorized IPC sender` | 从 settings 窗口调了 main-only 的 IPC |
| hdc 4229/9229 连不上 | 设备掉线 → `hdc kill && hdc start && hdc tconn ...`，再 `fport` |
| 装完看不到变化 | `aa start` 不抬前台；且设置窗口可能在主窗口后面 |
| CRLF 警告 | 仓库 `core.autocrlf=true`，属正常 |

---

## 10. 常用命令速查

```bash
T=192.168.124.26:45673
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# 连设备 / 救活
hdc tconn $T; hdc list targets
hdc kill; hdc start; sleep 2; hdc tconn $T

# 日志
hdc -t $T shell "hilog -r"
hdc -t $T shell "hilog -x" > run.log

# 装 + 起
cd /d/workspace/Netcatty/harmony/electron/build/default/outputs/default
hdc -t $T install -r electron-default-signed.hap
hdc -t $T shell "aa start -a EntryAbility -b com.AzadKuu.NetCatty"

# 截图
hdc -t $T shell "snapshot_display -f /data/local/tmp/s.jpeg"
hdc -t $T file recv /data/local/tmp/s.jpeg .harmony-diag/s.jpeg

# CDP
hdc -t $T fport rm tcp:9229 tcp:9229; hdc -t $T fport tcp:9229 tcp:9229
node .harmony-diag/cdp-file.mjs .harmony-diag/<script>.js --await

# 测试（示例）
node --test --import tsx electron/bridges/aiBridge/sdk/dshAcpDriver.test.cjs
node --test electron/bridges/tempDirBridge.test.cjs     # 本机有 3 个既有环境敏感失败，非回归
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "harmony/electron/build"
```

---

## 11. 远端 DSH 主机（当前配置）

- 主机：`mc.shawnli.online`（用户 `shawn`，openEuler 24.03 x86_64）
- 用户态安装：node `v24.14.0` → `~/.local/node24`；`npm i -g @deepseek-ai/dsh@0.2.2-rc.1` → `~/.npm-global`
- 凭据：`~/.dsh/.credentials.yaml`（只放 `refs.DEEPSEEK_API_KEY`，`chmod 600`）
- 启动：`~/.local/node24/bin/node ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile acp`
- Netcatty 侧：Settings → AI → DSH → 「Agent 主机」选该主机（写进自定义路径 `ssh://shawn@mc.shawnli.online`）
- 驱动会在 exec 前注入 PATH 前缀（非交互 SSH 不读登录 profile）：
  `export PATH="$HOME/.npm-global/bin:$HOME/.local/node24/bin:$HOME/.local/nodejs/bin:$HOME/.local/bin:$HOME/bin:$PATH"; exec dsh --profile acp`

> 设备上 `~/.harmonybrew/bin/dsh` 那个是 **0.1.5-rc.2，没有 ACP**，而且鸿蒙不允许 exec 它 —— 别在那条路上浪费时间。
