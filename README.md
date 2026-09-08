# SiYuan MCP

SiYuan MCP 是一个面向 ChatGPT、Codex、MCP Inspector 及其他 MCP Client 的远程 [Model Context Protocol](https://modelcontextprotocol.io/) Server。它把思源笔记的常用读写能力封装为标准 MCP 工具，让支持 MCP 的 AI 客户端能够查询笔记、读取 Markdown，以及在授权后创建或修改内容。

项目使用 TypeScript、Fastify 和官方 MCP TypeScript SDK，采用 Streamable HTTP 协议，对外端点为 `/mcp`。服务本身不保存思源笔记，也不会把 Token 写入镜像或日志。

```text
ChatGPT / MCP Client
        │  Authorization: Bearer <MCP Token 或 OAuth Access Token>
        ▼
SiYuan MCP Server  ── /mcp
        │  Authorization: Token <SIYUAN_TOKEN>
        ▼
SiYuan HTTP API
```

## 能做什么

| MCP Tool | 用途 | 类型 |
| --- | --- | --- |
| `list_notebooks` | 列出所有思源笔记本 | 只读 |
| `list_documents` | 浏览指定笔记本或父文档下的文档 | 只读 |
| `search_notes` | 搜索文档和内容块 | 只读 |
| `get_document` | 以 Markdown 读取完整文档 | 只读 |
| `create_document` | 在指定路径创建 Markdown 文档，不覆盖已有路径 | 写入 |
| `append_content` | 向文档或内容块追加 Markdown | 写入 |
| `update_block` | 用 Markdown 替换指定内容块 | 写入 |

HTTP 端点：

- `POST/GET/DELETE /mcp`：MCP Streamable HTTP。
- `OPTIONS /mcp`：跨域预检。
- `GET /health`：公开健康检查，正常时返回 `{"status":"ok"}`。
- `GET /.well-known/oauth-protected-resource`：仅在 OAuth 模式启用。

## 认证模型

系统中存在两套彼此独立的认证信息，不能混用。

### MCP Client → SiYuan MCP

固定 Token 模式下，客户端发送：

```http
Authorization: Bearer <MCP_FIXED_TOKEN>
```

`MCP_FIXED_TOKEN` 只保存 Token 本体；客户端 Header 中需要显式添加 `Bearer `。

### SiYuan MCP → SiYuan API

服务端访问思源时会自动发送：

```http
Authorization: Token <SIYUAN_TOKEN>
```

因此 `SIYUAN_TOKEN` **只能填写 Token 本体**：

```env
# 正确
SIYUAN_TOKEN=replace-with-siyuan-token-body

# 错误：会产生重复的认证前缀
SIYUAN_TOKEN=token replace-with-siyuan-token-body
```

## 环境变量

### Server 环境变量

| 变量 | 必填条件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 否 | `production` | `development`、`test` 或 `production`。 |
| `HOST` | 否 | `0.0.0.0` | Server 监听地址；仅本机测试可使用 `127.0.0.1`。 |
| `PORT` | 否 | `8080` | Server 监听端口，范围 `1-65535`。 |
| `AUTH_MODE` | 否 | `fixed` | `fixed` 或 `oauth`。 |
| `MCP_FIXED_TOKEN` | `AUTH_MODE=fixed` | 无 | MCP 客户端使用的固定 Token，至少 16 个字符。不要加 `Bearer `。 |
| `MCP_PUBLIC_URL` | `AUTH_MODE=oauth` | 无 | MCP 服务的公网 HTTPS 基础 URL，例如 `https://mcp.example.com`。 |
| `OAUTH_ISSUER_URL` | `AUTH_MODE=oauth` | 无 | OAuth Provider 的 issuer，必须与 JWT 的 `iss` 完全一致。 |
| `OAUTH_AUDIENCE` | `AUTH_MODE=oauth` | 无 | JWT 必须包含的 audience。 |
| `OAUTH_JWKS_URL` | 否 | `<issuer>/.well-known/jwks.json` | JWT 公钥集合地址；Provider 使用默认地址时可省略。 |
| `OAUTH_SCOPES` | 否 | `siyuan.read siyuan.write` | 空格分隔的可用 scope。 |
| `SIYUAN_BASE_URL` | 是 | 无 | 思源服务基础 URL，例如 `http://127.0.0.1:6806` 或公网 HTTPS 地址；不要包含 Markdown 链接语法。 |
| `SIYUAN_TOKEN` | 是 | 无 | 思源 API Token 本体；不要添加 `Token ` 或 `token ` 前缀。 |
| `SIYUAN_TIMEOUT_MS` | 否 | `20000` | 单次思源 API 请求超时，范围 `100-120000` 毫秒。 |
| `SIYUAN_READ_RETRIES` | 否 | `2` | 只读请求遇到临时网络错误或 502/503/504 时的重试次数，范围 `0-5`。写操作不会自动重试。 |

仓库中的 [`.env.example`](.env.example) 是配置模板。当前程序直接读取进程环境变量，`npm run dev` 和 `npm start` **不会自动加载 `.env` 文件**。Docker 的 `--env-file` 会加载它；Node.js 22 也可以使用 `node --env-file=.env ...`。

### 冒烟测试客户端变量

这些变量只供 `npm run smoke:client` 使用，不是 Server 配置。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MCP_URL` | 否 | `http://127.0.0.1:8080/mcp` | 要测试的完整 MCP URL。 |
| `MCP_AUTHORIZATION` | 是 | 无 | 完整认证 Header，例如 `Bearer <MCP_FIXED_TOKEN>`。 |
| `MCP_TEST_TOOL` | 否 | `list_notebooks` | 要调用的 Tool 名称。 |
| `MCP_TEST_ARGUMENTS` | 否 | `{}` | Tool 参数，必须是 JSON 对象字符串。 |

PowerShell 环境变量名应直接使用下划线，例如 `$env:SIYUAN_TOKEN`。不要写成 `$env:SIYUAN\_TOKEN`。

## 本地启动：固定 Token 模式

要求：

- Node.js 22 或更高版本。
- 一个可访问的思源服务。
- 已在思源设置中生成 API Token。

安装依赖：

```powershell
git clone git@github.com:remixu1994/siyuan-mcp.git
cd siyuan-mcp
npm ci
```

在 PowerShell 中设置环境变量并启动开发 Server：

```powershell
$env:NODE_ENV = "development"
$env:HOST = "127.0.0.1"
$env:PORT = "8080"

$env:AUTH_MODE = "fixed"
$env:MCP_FIXED_TOKEN = "replace-with-at-least-16-characters"

$env:SIYUAN_BASE_URL = "http://127.0.0.1:6806"
$env:SIYUAN_TOKEN = "replace-with-siyuan-token-body"
$env:SIYUAN_TIMEOUT_MS = "20000"
$env:SIYUAN_READ_RETRIES = "2"

npm run dev
```

环境变量只影响从当前 PowerShell 启动的新进程。修改 Token 后，需要按 `Ctrl+C` 停止旧 Server，再执行 `npm run dev`。

检查健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
```

生产方式运行：

```powershell
npm run build
npm start
```

如果希望从 `.env` 加载生产配置：

```powershell
Copy-Item .env.example .env
# 编辑 .env，替换所有示例值
npm run build
node --env-file=.env dist/server.js
```

不要提交 `.env`；它已包含在 `.gitignore` 中。

## 使用 MCP Client 验证

Server 启动后，另开一个 PowerShell 窗口：

```powershell
$env:MCP_URL = "http://127.0.0.1:8080/mcp"
$env:MCP_AUTHORIZATION = "Bearer replace-with-the-same-mcp-fixed-token"
$env:MCP_TEST_TOOL = "list_notebooks"
Remove-Item Env:MCP_TEST_ARGUMENTS -ErrorAction SilentlyContinue

npm run smoke:client
```

成功结果会包含：

```json
{
  "connected": true,
  "endpoint": "http://127.0.0.1:8080/mcp",
  "tools": [
    "list_notebooks",
    "list_documents",
    "search_notes",
    "get_document",
    "create_document",
    "append_content",
    "update_block"
  ]
}
```

读取指定文档：

```powershell
$env:MCP_TEST_TOOL = "get_document"
$env:MCP_TEST_ARGUMENTS = '{"documentId":"20260908153006-0q6njnf"}'
npm run smoke:client
```

如果出现 `SIYUAN_AUTH_FAILED`，说明 MCP 鉴权已经通过，但 `SIYUAN_TOKEN` 被思源拒绝。优先检查是否错误地把 `token ` 一起写进了变量，并在修改后重启 Server。

## ChatGPT GUI

`AUTH_MODE=fixed` 适用于 MCP Inspector、脚本和能够自行设置 `Authorization` Header 的客户端。ChatGPT GUI 不能用这种方式让用户输入自定义 API Key；涉及私有数据或写操作的公网 MCP 应使用 OAuth。

本项目在 `AUTH_MODE=oauth` 时充当 OAuth Resource Server：它验证 JWT 签名、issuer、audience、有效期及 scope，但**不负责登录页面、授权码签发或 Token 签发**。你仍需部署符合 MCP OAuth 要求的 OAuth Provider。

示例配置：

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=8080

AUTH_MODE=oauth
MCP_PUBLIC_URL=https://siyuan-mcp.example.com
OAUTH_ISSUER_URL=https://issuer.example.com/
OAUTH_AUDIENCE=https://siyuan-mcp.example.com
OAUTH_JWKS_URL=https://issuer.example.com/.well-known/jwks.json
OAUTH_SCOPES=siyuan.read siyuan.write

SIYUAN_BASE_URL=https://siyuan.example.com
SIYUAN_TOKEN=replace-with-siyuan-token-body
SIYUAN_TIMEOUT_MS=20000
SIYUAN_READ_RETRIES=2
```

权限要求：

- 只读 Tool 需要 `siyuan.read`。
- `create_document`、`append_content`、`update_block` 需要 `siyuan.write`。
- `OAUTH_ISSUER_URL` 必须与 JWT `iss` 完全一致，包括尾部斜杠。
- `OAUTH_AUDIENCE` 必须与 JWT `aud` 匹配。

连接 ChatGPT：

1. 把 Server 部署为公网可访问的 HTTPS 服务，并确认 `https://your-domain.example/mcp` 可用。
2. 配置 OAuth Provider 和上述 OAuth 环境变量。
3. 在 ChatGPT 中开启 Developer mode。
4. 创建插件连接并填入完整的 `/mcp` URL。
5. 完成 OAuth 授权，确认 ChatGPT 能发现 7 个 Tool。
6. 分别验证只读和写入调用，并检查 scope 限制。

相关官方 OpenAI 文档：

- [Plugins Quickstart](https://developers.openai.com/plugins/quickstart)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Authenticate users](https://developers.openai.com/plugins/build/auth)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Docker

先从模板创建 `.env` 并替换所有示例值：

```powershell
Copy-Item .env.example .env
docker build -t siyuan-mcp:local .
docker run --rm -p 8080:8080 --env-file .env siyuan-mcp:local
```

容器内的 `127.0.0.1` 指向容器自身。如果思源运行在 Windows 或 macOS 宿主机上，应配置：

```env
SIYUAN_BASE_URL=http://host.docker.internal:6806
```

镜像采用多阶段构建并以非 root 用户运行，Token 仅在容器启动时通过环境变量注入，不会写入镜像层。

## GitHub Actions 与 GHCR

[`.github/workflows/container.yml`](.github/workflows/container.yml) 会执行：

- Pull Request：类型检查、测试、构建项目和 Docker 镜像，但不推送镜像。
- 推送到 `main`：验证后将 `linux/amd64`、`linux/arm64` 镜像发布到 GHCR，并生成 `latest`、分支及 commit SHA 标签。
- 推送 `v*` Tag：发布对应版本标签。
- `workflow_dispatch`：允许从 GitHub Actions 页面手动运行。

镜像地址：

```text
ghcr.io/remixu1994/siyuan-mcp
```

拉取和运行：

```powershell
docker pull ghcr.io/remixu1994/siyuan-mcp:latest
docker run --rm -p 8080:8080 --env-file .env ghcr.io/remixu1994/siyuan-mcp:latest
```

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN` 发布 GHCR 镜像，不需要额外保存 GHCR 密码。仓库或 Package 必须允许目标用户拉取镜像。

## 开发与测试

```powershell
npm run typecheck
npm test
npm run build
```

主要脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 用 `tsx watch` 启动开发 Server。 |
| `npm run build` | 编译 TypeScript 到 `dist/`。 |
| `npm start` | 运行已经编译的 `dist/server.js`。 |
| `npm run smoke:client` | 用官方 MCP Client SDK 连接 Server、列出 Tool 并调用一个 Tool。 |
| `npm run typecheck` | 只进行 TypeScript 类型检查。 |
| `npm test` | 运行 Vitest 单元和集成测试。 |

## 安全与行为边界

- MCP Token 与思源 Token 分离，服务端日志不记录认证 Header 或 Token。
- 日志不记录完整 Markdown 或完整笔记内容。
- SQL 完全由 Server 根据结构化参数生成，MCP Client 不能提交任意 SQL。
- `create_document` 在写入前检查路径，不覆盖同路径文档。
- 只读请求仅对可恢复的临时错误有限重试。
- 写请求不会自动重试；结果无法确认时返回 `OPERATION_STATUS_UNKNOWN`，避免重复写入。
- 不要把固定 Token 模式或思源 Token 直接暴露到公网；ChatGPT GUI 部署应使用 OAuth 和 HTTPS。

更详细的 MVP 范围、错误模型和验收标准见 [`docs/MVP.md`](docs/MVP.md)。
