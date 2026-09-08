# SiYuan MCP V0.1 — 可执行 MVP

## 产品结论

V0.1 验证一条真实链路：ChatGPT GUI 或标准 MCP Client 经过认证后，通过远程 MCP 搜索、读取、创建、追加和修改个人 SiYuan 笔记。

```text
ChatGPT GUI ── OAuth 2.1 JWT ─┐
                              ├─> SiYuan MCP ── SiYuan Token ──> SiYuan HTTP API
MCP Client ── Fixed Bearer ───┘
Anonymous client ── No auth ──> SiYuan MCP（仅 4 个只读工具）
```

三种入口模式是部署时互斥的 `AUTH_MODE`，不能在同一实例中混用。`none` 模式仅注册只读工具；`SIYUAN_TOKEN` 永远只存在于服务端。

## 相对基础方案的必要调整

ChatGPT GUI 是首要客户端后，原方案中的“固定 Token + 不做 OAuth”无法同时成立。OpenAI 官方认证文档说明 ChatGPT 不能携带自定义 API Key；访问用户私有数据或执行写操作的 MCP 应采用 OAuth 2.1。

因此：

- 固定 Token 仍是通用 MCP Client 的最小路径。
- 匿名模式仅用于无认证的只读联调，不属于私有数据的安全生产方案。
- ChatGPT GUI 的 Definition of Done 以 OAuth 模式为准。
- V0.1 实现 OAuth Resource Server 验证与发现元数据，但不自行实现身份库或授权服务器。
- OAuth Provider 必须支持 MCP 所需的发现、Authorization Code、PKCE S256、JWT audience/resource 和 scope。

## 范围

保留 7 个工具：`list_notebooks`、`list_documents`、`search_notes`、`get_document`、`create_document`、`append_content`、`update_block`。

不实现删除、附件、图片、数据库持久化、管理后台、Apps SDK Widget、legacy SSE、Nginx/TLS/DNS 或自建 OAuth Provider。

## API 映射

| Tool | SiYuan 官方 API |
| --- | --- |
| `list_notebooks` | `/api/notebook/lsNotebooks` |
| `list_documents` | 服务端受控 `/api/query/sql` |
| `search_notes` | 服务端受控 `/api/query/sql` |
| `get_document` | `/api/export/exportMdContent` |
| `create_document` | `/api/filetree/getIDsByHPath` + `/api/filetree/createDocWithMd` |
| `append_content` | `/api/block/appendBlock` |
| `update_block` | `/api/block/updateBlock` |

SQL 仅由服务端模板生成并转义参数。MCP schema 不存在 `sql` 输入。

## 安全与失败语义

- `/health` 公开；fixed/oauth 模式的 `/mcp` 需要认证，none 模式允许匿名只读访问。
- OAuth JWT 校验 issuer、audience、签名、有效期和 scope。
- 固定 Token 使用常量时间比较。
- 读工具要求 `siyuan.read`，写工具要求 `siyuan.write`。
- 读调用仅对临时故障重试，默认最多 2 次。
- 写调用不重试；网络或网关结果不确定时返回 `OPERATION_STATUS_UNKNOWN`。
- 工具错误不返回堆栈、文件路径、Token 或 Authorization Header。

## 容器交付

Dockerfile 使用 Node.js 22、多阶段构建和非 root runtime。GitHub Actions 先执行 typecheck、test、build，再通过 Buildx 构建 `linux/amd64` 与 `linux/arm64`，推送到 GHCR。

PR 只构建不推送；`main`、`v*` 标签与手动工作流会推送。

## Definition of Done

- `/health` 返回 `{ "status": "ok" }`。
- 未认证和错误认证访问 `/mcp` 返回 401。
- OAuth 模式发布 protected resource metadata，并能验证 Provider JWT。
- none 模式无需 Authorization 即可初始化，且 `tools/list` 只返回 4 个只读工具。
- MCP `initialize`、`tools/list`、`tools/call` 成功。
- `tools/list` 可发现 7 个带 title、description、schema 和安全 annotations 的工具。
- 7 个工具通过真实 SiYuan 验收，写入结果在 SiYuan GUI 中可见且不重复。
- ChatGPT Developer mode 可通过公网 HTTPS `/mcp` 完成 OAuth 连接并正确选择工具。
- `npm run typecheck`、`npm test`、`npm run build` 成功。
- Docker 镜像健康检查成功，GHCR 工作流可发布镜像。
- 仓库、日志、测试夹具和镜像层中不存在真实 Token。

## 最终人工验收

1. 用 MCP Inspector 分别验证 initialize、tools/list 和 7 个 tools/call。
2. 在 ChatGPT Developer mode 添加公网 `/mcp` URL 并完成 OAuth linking。
3. 依次列出 Notebook、搜索关键词、读取文档、创建测试文档、追加章节、修改一个 Block。
4. 在 SiYuan GUI 确认 Markdown 正确、内容真实存在、没有重复写入。
5. 删除人工测试数据属于人工清理，不通过 MCP 暴露删除工具。
