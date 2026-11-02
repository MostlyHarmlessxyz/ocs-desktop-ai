# OCS Desktop AI

基于 OCS Desktop 3.8.0 的独立定制版，增加本地 Codex 搜题、题库答案校验、人工复核和调用记录。
应用使用独立的 `OCS Desktop AI` 数据目录，不读取旧版搜题数据，也不从官方自动更新源覆盖安装。

## 智能搜题

在“软件设置 → 智能搜题”中检测本机 Codex，再发送测试题。默认跟随 Codex／CC Switch 配置；
也可为首次作答与二次裁决分别指定模型、思考强度和联网搜索。模型能力来自本机目录或缓存，
未知模型支持手动输入；空思考强度表示跟随 CLI 配置。OCS 不修改 Codex 的配置或凭证。

每次调用均解析本机当前 `codex` 可执行文件，直接继承启动环境和工作目录，不捆绑固定 CLI 版本，
不额外指定沙箱、忽略规则或隔离会话。系统更新 Codex 后，后续调用使用更新后的版本。

答案策略支持双源校验（默认）、题库优先和仅模型。智能搜题页集中展示任务、历史、答案来源、
采用理由与待复核题目，可暂停、取消、重试或人工改选。正式考试只填写，不自动提交。
超星章节测试／作业最多追加两轮未完成题补答；提交前检查页面实际填写，并等待服务端结果确认。

当前用户脚本适配验证版本为 **OCS 5.2.3、4.13.16**；脚本不兼容时会提示并停止启动，保留原有浏览器配置。
已安装脚本不包含服务凭据，仅能通过受管浏览器 Worker 的内存桥接工作。

Clash TUN 模式下保持代理地址为空。只有需要显式 HTTP/HTTPS 代理时才填写代理地址；
该配置仅传给 Codex 子进程，不修改系统代理。桌面启动找不到 CLI 时，可设置其可执行文件绝对路径。
高级环境变量：`OCS_CODEX_COMMAND`、`OCS_CODEX_MODEL`、`OCS_CODEX_REASONING_EFFORT`、
`OCS_CODEX_WEB_SEARCH`、`OCS_CODEX_TIMEOUT_MS`、`OCS_CODEX_MAX_CONCURRENT`、`OCS_CODEX_PROXY`。

题图会按实际文件内容识别，忽略空图片地址和被误识别为图片的当前页面链接。
不再限制单图 8 MiB、每题 8 张或总计 24 MiB；所有有效附件按顺序传给本机 CLI。
本地题目接口的请求容量默认 256 MiB（包含 base64 编码开销），可用 `OCS_QUESTION_MAX_REQUEST_MB` 调整。
非图片响应、附件读取失败和请求容量超限会分别报告具体原因。

超星自定义字体题先等待 OCS 原生字体还原完成，再直接读取题干、选项文字和原题图片，不截取题目画面。
同一页面的字体转换合并执行，嵌套内容只转换一次，并清除已转换内容的加密字体样式；旧版转换保留图片和表单节点。
字体转换失败时会在课程页提示恢复操作，可重新开始答题；iframe 题目按其所属文档转换。
上游明确提供的图片列表（包括空列表）优先，懒加载图片在上游提取时读取；旧脚本缺少列表时才扫描题干与选项。
选择题输出限定为选项编号；答案仍需通过页面实际选中状态检查。填空题按页面顺序保留空位数量。
技术故障显示为执行失败，不进入待复核；内容不完整时需在课程页重新采集。浏览器预览独立于搜题流程。
同页状态统一批量查询，页面断开后停止等待并保留历史。旧的缺图复核记录在启动时转为失败记录，不删除答案或调用记录。

## Arch Linux 构建与运行

当前工作区已编译时，无需安装，在项目根目录直接运行：

```bash
./ocs
```

启动器优先使用 `releases/current/ocs-desktop-ai`，兼容旧的 `releases/linux-unpacked/ocs-desktop-ai`，继承调用时的工作目录与环境，
不依赖 AppImage 挂载；修改源码后运行 `pnpm build:linux` 更新可执行程序。
构建产物放入独立目录，完成后切换启动入口，正在运行的旧版本文件保持可用；重启应用后加载新版。

建议使用 Node.js 22 和 pnpm 10.21.0。运行产物不需要系统安装 Node.js；搜题需要另行安装并登录 Codex CLI。
构建环境需要基础编译工具、`libsecret`，运行需要 GTK3、NSS、ALSA、Mesa 等 Electron 系统库。
AppImage 挂载需要 `fuse2`，也可使用解包目录运行。

受管浏览器在 Wayland 会话中优先使用原生 Wayland；桌面启动器未传递显示变量时，会检测当前用户的显示套接字。
`OCS_AI_PORT` 可设置独立的本地服务端口，默认 `15319`。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build:linux
chmod +x releases/ocs-ai-3.8.0-linux-x86_64.AppImage
./releases/ocs-ai-3.8.0-linux-x86_64.AppImage
# 不使用 FUSE 的运行方式
./releases/current/ocs-desktop-ai
```

首次启动会下载并校验兼容的 Chrome for Testing，然后引导安装脚本管理器与 OCS 脚本。
配置与题目记录默认位于 `~/.config/OCS Desktop AI/`；`OCS_AI_USER_DATA` 可指定独立测试数据目录。
记录保存在其 `question-assistant/` 子目录，调用详情按 2,000 条／16 MiB 轮转。

以下为上游项目的开发环境说明。

拥有 一键刷课，多账号刷课，浏览器多开/分身，浏览器管理，自动登录，等功能，支持 Windows, Linux, Mac 多个操作系统。

## 初始化项目依赖

### 方式一：一键环境初始化（推荐）

使用环境构建脚本，自动完成 Node.js（>= 22）、pnpm（>= 10）的检测与安装，并配置 Electron 国内镜像源后安装依赖：

```bash
# macOS / Linux / Windows Git Bash
pnpm setup            # 或 bash ./scripts/setup.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File ./scripts/setup.ps1
```

可选环境变量：

```bash
# Node.js 下载镜像（国内加速）
export NODEJS_MIRROR=https://npmmirror.com/mirrors/node

# 禁用 Electron 国内镜像（默认使用 npmmirror）
export ELECTRON_MIRROR=off
```

### 方式二：手动安装

```bash
# 启用 Corepack（Node.js 自带的包管理器管理工具，会自动识别 packageManager 字段安装对应版本的 pnpm）
corepack enable

# 安装依赖
pnpm install
```

## 运行

一键启动开发环境（Electron Vite 同时启动主进程和 Web 开发服务器，共享代码直接从源码编译）：

```bash
pnpm dev
```

开发服务器启动后，可访问 http://localhost:3000 预览 Web 界面。

## 打包

```bash
pnpm build
```

浏览器由应用首次启动时下载，构建无需手动删除依赖中的 Chromium 文件。
