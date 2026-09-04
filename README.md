# Federated Shader Sources → NetEase Minecraft Toolkit

这是一个可移植的 Codex 插件仓库。它将 `$port-shadertoy-to-netease` Skill 与两个本地、stdio MCP 服务一起分发，用于把经过授权的 shader 或图形知识资料，审慎地学习、分析并移植到网易《我的世界》AddOn。

- `shadertoy-netease` 保留既有的 Shadertoy 官方 API 本地库、检索、静态分析和网易适配候选排序能力。
- `shader-source-registry` 以来源策略为边界，识别受支持 URL、维护合规的本地索引、记录许可与出处，并分析用户获准提供的通用 shader 源码。

“学习”在本工具中是按需检索、受限缓存、结构化分析和从资料提炼原创实现思路；它不是对模型进行训练，也不表示本仓库获得了任何第三方作品的再分发权。

本工具不是全站 HTML 爬虫，不会绕过登录、robots、可见性、限流、付费墙或其他访问控制。仓库不包含 API Key、SQLite 数据库、已缓存的第三方源码或本机 Codex 配置。

## 受支持来源与边界

| 来源 | 用途与访问边界 | 自动化范围 |
| --- | --- | --- |
| Shadertoy | 既有官方 `Public + API` 工作流；具体作品仍以作者许可为准 | 仅显式、配额受限的官方 API 刷新/同步 |
| ISF 标准库 | Vidvox 官方 `ISF-Files` 标准库文件 | 仅官方库的分步索引；保留上游 MIT 许可与声明 |
| twigl.app | URL 内显式源码，或 `ol=true&ss=<id>` 玩家分享链接 | 玩家作品许可未知。仅在 `user-owned`、`licensed` 或 `author-permission` 授权基础下，对固定实验性 Firebase snapshot 端点作一次有界请求；`reference-only` / `repository-license` 全程零网络且只存链接/元数据；绝不枚举频道或目录 |
| The Book of Shaders（含中文） | 图形知识与算法学习 | 仅链接/章节引用，禁止缓存页面正文；可零网络播种内置原创主题链接索引 |
| ShaderFrog | 单个 editor 链接或用户导出的源码 | 不爬站、不自动抓取作品；仅进行用户提供源码的 `user-supplied-source-analysis`，先由用户提供获授权内容 |
| Godot Shaders | 规范的单个 `/shader/<slug>/` 作品链接 | `reference-only` / `repository-license` 只请求页面、存页面证据/元数据，绝不请求 detail API，未核验源码头前不得给最终可复用分类；仅 `user-owned` / `licensed` / `author-permission` 且目标文章含单一受支持 CC0/MIT/GPLv3 时，才请求固定 detail API；缓存还要求领先源码头恰好声明一个相同许可，缺失、限制语、混合或冲突均禁止缓存且 `review_required`；绝不爬目录或媒体 |
| WebGL Fundamentals | 官方 BSD-3-Clause 课程资料 | 仅官方仓库 lessons Markdown 的受限全文本地索引；排除第三方目录、资源与图片 |

在没有另行、可审计的 work-specific authority（例如 `user-owned`、明确许可或作者授权）时，未知、缺失或互相矛盾的许可不会被视作可复制、可缓存或可分发。此时只能给出链接、可行性说明或独立原创的 look-alike 方案。

## 环境要求

- 支持本地或仓库 marketplace 的 Codex / ChatGPT 桌面版。
- Node.js 24 或更高版本；两个 MCP 都依赖内置 `node:sqlite`，没有第三方 npm 运行时依赖。
- Python 3 仅用于直接运行 Skill 附带的离线分析器。
- `SHADERTOY_API_KEY` 仅在主动调用既有 Shadertoy 官方刷新/同步时需要。

## 伴随 Skills

本仓库只分发自己的 `port-shadertoy-to-netease` Skill 与两个 MCP；下列伴随 Skills 不随包复制，也不会因本插件安装而自动获得。

**必需（实际 shader 端口/审查时）：** `glsl-fundamentals`。缺失时仍可登记来源或进行有限文本分析，但不能把结果称为完整 GLSL 移植审查。

**必需（要声称网易接口、资源入口或 API 已查证时）：** `mc-search` 与 `netease-docs`。缺失时只可标注待核实，不能编造目标版本接口。

**按需可选：** `glsl-coordinates`、`glsl-math`、`glsl-color`、`glsl-noise`、`glsl-sdf`、`netease-mc-ui-skill`、`mod-workflow`、`netease-python-addon-rules`、`mcdk-game-test-workflow` 和 `multi-agent-orchestration`。

若 `netease-mc-ui-skill` 不可用，则不要编辑 UI JSON 或 `shaders/glsl` 下的 UI shader；若 `mcdk-game-test-workflow` 不可用，则静态检查不等同于 MCDK 或游戏内验收。伴随 Skill 的安装方式由使用者信任的 Skill 来源决定。

## 安装

此仓库采用专有许可，应保持为私有仓库；安装者需要使用已获授权的 GitHub 账号。

```powershell
codex plugin marketplace add Moki-fit/shadertoy-netease-toolkit --ref main
codex plugin add shadertoy-netease-toolkit@moki-fit-tools
```

从已检出的本地仓库安装时，用路径占位符，不依赖某个开发机盘符：

```powershell
codex plugin marketplace add '<repository-path>'
codex plugin add shadertoy-netease-toolkit@moki-fit-tools
```

更新后请新建一个 Codex 任务，再确认 Skill 与两个 MCP 服务是否已发现。

## 可选 Shadertoy API Key

只通过启动 Codex 的进程环境配置 Key：

```powershell
$env:SHADERTOY_API_KEY = '<your-key>'
```

不要把 Key 写入 `.mcp.json`、Skill、AddOn、提交记录或聊天内容。没有 Key 时，本地检索、来源解析和离线分析仍可用；既有 Shadertoy 远程刷新/同步会返回结构化 `auth_required` 结果。

## MCP 工具概览

`shadertoy-netease`（兼容保留）：

- `shadertoy_library_status`
- `search_shadertoy_library`
- `get_shadertoy_project`
- `refresh_shadertoy_project`
- `sync_shadertoy_catalog_step`
- `analyze_shadertoy_source`
- `rank_netease_candidates`

`shader-source-registry`（v0.2）：

- `shader_source_registry_status`
- `resolve_shader_source_url`
- `search_shader_sources`
- `get_shader_source_record`
- `import_shader_link`
- `sync_shader_source_step`
- `analyze_shader_source`

新服务始终先把 URL 解析为受支持来源与规范链接；它不接受任意远程 URL、任意本地路径或 SQL。`sync_shader_source_step` 的**联网**维护只允许 `provider: "isf"` 或 `provider: "webgl-fundamentals"`；`provider: "book-of-shaders"` 只能零网络播种内置原创主题的链接索引，永不缓存章节正文。所有同步都必须是用户显式、有限的维护动作。

## 数据、源码与许可

既有 Shadertoy 库默认位于 `%CODEX_HOME%\data\shadertoy-netease`，可通过 `SHADERTOY_DATA_DIR` 指向仓库外目录。v0.2 来源注册表优先使用 `SHADER_SOURCE_DATA_DIR` 存放独立的 `resources-v2.sqlite3`，未设置时才回退到既有目录规则。任何导入、缓存和导出都应位于仓库外，不应进入 Git。

只交给 MCP 处理你明确获准提供的内容。源码默认不返回，但显式请求的有界源码窗口、导入源码和本地缓存都可能进入连接的 MCP/Codex 上下文。不要导入私有、付费、受 NDA 保护或没有授权的作品。

交付时保留作者、规范 URL、来源、许可依据和所需署名。各来源的细则见 [NOTICE.md](NOTICE.md)、[SECURITY.md](SECURITY.md) 与 Skill 的 `provider-source-policy.md`。

## 开发与验证

```powershell
Set-Location .\plugins\shadertoy-netease-toolkit\mcp
npm.cmd test
node .\src\mcp-server.mjs
node .\src\sources\source-mcp-server.mjs
```

stdio MCP 必须直接使用 `node` 启动；不要用 `npm start` 等可能向 stdout 写横幅的包装器。静态分析、索引成功或单元测试通过，都不等于 GLSL 编译、网易 MCDK 测试或游戏内验收。实际 AddOn 仍要核实目标版本、真实资源入口、客户端/服务端边界和设备性能。
