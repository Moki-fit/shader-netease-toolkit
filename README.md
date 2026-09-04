# Shadertoy → NetEase Minecraft Toolkit

这是一个可移植的 Codex 插件仓库，把以下两部分一起分发：

- `port-shadertoy-to-netease` Skill：按规范分析 Shadertoy 或类似 GLSL 效果，先确认真实渲染入口、通道和许可证，再规划或实现网易《我的世界》移植。
- `shadertoy-netease` MCP：本地缓存、检索、源码静态分析和网易适配候选排序；只有显式刷新或同步时才访问 Shadertoy 官方 Public + API 接口。

它不是全站 HTML 爬虫，也不会绕过登录、作品可见性、API 配额或其他访问控制。仓库不包含 API Key、SQLite 数据库、已缓存作品源码或本机 Codex 配置。

## 目录结构

```text
.agents/plugins/marketplace.json
plugins/shadertoy-netease-toolkit/
├─ .codex-plugin/plugin.json
├─ .mcp.json
├─ skills/port-shadertoy-to-netease/
└─ mcp/
```

## 环境要求

- Codex / ChatGPT 桌面版中支持本地或仓库 marketplace 的版本
- Node.js 24 或更高版本（MCP 使用内置 `node:sqlite`，没有第三方 npm 运行时依赖）
- Python 3（仅在直接运行 Skill 自带的离线分析器时需要；已用 Python 3.12 验证，不会进入网易 AddOn）
- 只有刷新和同步官方数据时才需要 `SHADERTOY_API_KEY`

## 伴随 Skills

本仓库只分发本项目拥有的主 Skill 与 MCP，不复制具有独立发布周期或来源的伴随 Skills。要严格执行完整移植工作流，请从你信任的 Skill 来源另行安装：

- 每次 shader 移植都需要：`glsl-fundamentals`
- 查证网易入口、API 和资源格式需要：`mc-search`、`netease-docs`
- 按实际目标条件使用：`glsl-coordinates`、`glsl-math`、`glsl-color`、`glsl-noise`、`glsl-sdf`、`netease-mc-ui-skill`、`mod-workflow`、`netease-python-addon-rules`、`mcdk-game-test-workflow`、`multi-agent-orchestration`

缺少伴随 Skill 时，本包的本地库、源码分析和 intake 工作仍可运行，但不得声称已完成相应的网易接口查证、GLSL 专项审查或游戏内验证。当前作者机器已单独全局安装这些伴随 Skills；它们不是本仓库内容。

## 从 GitHub 安装

当前发布采用专有许可证，因此 GitHub 仓库应保持私有；安装者需要先以获授权的 GitHub 账号登录。

```powershell
codex plugin marketplace add Moki-fit/shadertoy-netease-toolkit --ref main
codex plugin add shadertoy-netease-toolkit@moki-fit-tools
```

也可以在 Codex / ChatGPT 桌面版的插件目录中选择 `Moki Fit Shader Tools` 并安装。安装或更新后，请新建一个任务验证 Skill 和 MCP 是否被发现。

## 从本地目录安装

```powershell
codex plugin marketplace add '<repository-path>'
codex plugin add shadertoy-netease-toolkit@moki-fit-tools
```

插件内 MCP 使用 `cwd: "."` 与相对入口 `./mcp/src/mcp-server.mjs`，不会绑定某个用户目录或磁盘盘符。

## 可选的 Shadertoy API Key

从 Shadertoy 官方 My Apps 页面取得 Key 后，只通过启动 Codex 的进程环境设置：

```powershell
$env:SHADERTOY_API_KEY = '<your-key>'
```

不要把 Key 写进 `.mcp.json`、Skill、AddOn、提交记录或聊天内容。未设置 Key 时，本地分析、搜索和读取仍可使用；远程刷新与同步会返回结构化 `auth_required`。

marketplace 使用 `ON_USE`，因为安装和离线功能不需要身份凭据，只有用户主动调用官方刷新/同步时才需要可选 API Key。

CLI 的 `import-json` 只能用于你有权交给当前 Codex/MCP 客户端处理的源码。项目源码默认不返回，但显式使用 `include_source` 和有界窗口时，所选源码片段会进入连接客户端的上下文；不要导入未经授权的私有作品。

默认数据库位于 `%CODEX_HOME%\data\shadertoy-netease`；也可用 `SHADERTOY_DATA_DIR` 指定仓库外目录。数据库、WAL/SHM 文件和环境文件均已被 `.gitignore` 排除。

## MCP 工具

- `shadertoy_library_status`
- `search_shadertoy_library`
- `get_shadertoy_project`
- `refresh_shadertoy_project`
- `sync_shadertoy_catalog_step`
- `analyze_shadertoy_source`
- `rank_netease_candidates`

## 开发与验证

```powershell
Set-Location .\plugins\shadertoy-netease-toolkit\mcp
npm.cmd test
node .\src\mcp-server.mjs
```

stdio MCP 必须直接使用 `node` 启动；不要通过 `npm start`，否则 npm 的横幅可能污染 JSON-RPC stdout。

静态分析结果不等于 GLSL 编译、网易 MCDK 测试或游戏内验收。对具体 AddOn 的实现仍需核实目标版本、真实资源入口、客户端/服务端边界以及设备性能。

## 来源、许可与商标

工具不会随仓库分发第三方 shader。通过官方 API 缓存的每个作品仍受作者声明的许可证和 Shadertoy 条款约束；使用者必须保留作者、作品 ID、规范 URL 和许可信息。详见 [Shadertoy How-to](https://www.shadertoy.com/howto)、[Shadertoy Terms](https://www.shadertoy.com/terms) 与 [NOTICE.md](NOTICE.md)。

本仓库当前为专有发布，未经版权所有者书面许可不得再分发。Minecraft、网易和 Shadertoy 均为其各自权利人的名称或商标，本项目与它们没有隶属或背书关系。
