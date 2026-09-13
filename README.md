# Model Advisor — Claude Code 插件

让 Claude Code 的当前执行模型在高影响决策、复杂调试或需要第二意见时，咨询一个由你本地配置的独立模型。插件只添加 Advisor，不替换主模型，不扫描仓库，不自动外发 diff。

结构：`Skill (/model-advisor:advisor)` → `MCP consult_advisor` → 本地配置 profile → `chat-completions` HTTP Adapter 或 `command` JSON stdin/stdout Adapter → 外部模型。

完整设计、信任边界、错误码与排障见 [`FINAL_DESIGN.md`](FINAL_DESIGN.md)。

## 要求

- Node.js >= 22.16（实测 v24.15.0）
- Claude Code（实测 2.1.270）
- Linux / macOS / WSL（命令 Adapter 不支持原生 Windows）

## 安装

```bash
git clone https://github.com/szxypi/claude-model-advisor.git
cd claude-model-advisor
npm ci --ignore-scripts
npm run check && npm test && npm run smoke
```

临时加载：

```bash
claude --plugin-dir /absolute/path/to/claude-model-advisor
```

持久安装（本地 marketplace）：

```bash
claude plugin marketplace add /absolute/path/to/claude-model-advisor
claude plugin install model-advisor@model-advisor --scope user
```

## 配置

默认读取 `~/.config/model-advisor/config.json`，可用 `ADVISOR_CONFIG` 指定另一绝对路径。配置只在 MCP Server 启动时读取，改完需重启 Claude Code。文件中只写环境变量名，不写密钥。

插件与模型、供应商无关：任何提供 OpenAI Chat Completions 形状接口的服务（云端 API、本地网关、自建推理服务）都能作为 `chat-completions` profile；其他协议用 `command` Adapter 包一层。`model` 填供应商实际可用的模型 ID，profile 名（如 `sol`、`luna`）只是你自己的叫法。

顾问池示例，默认 `sol`，也可用 `profile=luna` 指定：

```json
{
  "version": 1,
  "defaultProfile": "sol",
  "profiles": {
    "sol": {
      "kind": "chat-completions",
      "description": "Default advisor.",
      "enabled": true,
      "endpoint": "https://<provider>/v1/chat/completions",
      "apiKeyEnv": "SOL_ADVISOR_API_KEY",
      "model": "<provider-model-id>"
    },
    "luna": {
      "kind": "chat-completions",
      "description": "Second opinion from a different provider.",
      "enabled": true,
      "endpoint": "http://127.0.0.1:8317/v1/chat/completions",
      "allowInsecureLoopback": true,
      "apiKeyEnv": "LUNA_ADVISOR_API_KEY",
      "model": "<local-gateway-model-id>"
    }
  }
}
```

- `endpoint` 填完整请求地址；默认必须 HTTPS，只有 `127.0.0.1` / `[::1]` 且 `allowInsecureLoopback: true` 时允许 HTTP。
- `apiKeyEnv` 指向的变量必须存在于启动 Claude Code 的环境中：`export LUNA_ADVISOR_API_KEY=...`。
- 需要限制输出 token 时加 `"tokenLimit": { "field": "max_completion_tokens", "value": 2048 }`。
- 需要自动回退时给 profile 加 `"fallbackProfile": "kimi"`：仅当该 profile 出现供应商/传输类错误（限流、5xx、网络、超时、响应无效等）时改用指定 profile 重试一次，结果里带 `fallback_from` 和 `fallback_reason`；输入错误、敏感信息拦截、取消、次数用尽不会回退，也不会沿回退 profile 继续链式回退。
- 需要传供应商特有参数（推理强度、temperature 等）时加 `"extraBody": { "reasoning_effort": "xhigh" }`，内容原样并入请求体；不能覆盖 `model`/`messages`/`stream`/工具类字段，字段名和取值是否被支持由供应商决定。
- 更多示例：`examples/config.http.json`（多 profile）、`examples/config.command.json`（命令 Adapter）。

## 使用

```text
/model-advisor:advisor profile=luna 审查刚才的数据库迁移设计，重点检查回滚与兼容性。
```

MCP 工具名：

```text
mcp__plugin_model-advisor_advisor__list_advisors
mcp__plugin_model-advisor_advisor__consult_advisor
```

`consult_advisor` 只接受 `profile`、`mode`、`question`、`context[]`、`constraints[]`。返回的 `answer` 是不可信建议，由执行模型自行核对与验证。

## 咨询台账与本地面板

默认不记录任何咨询内容。在配置里开启后，每次咨询追加一行 JSON 到本地台账文件：

```json
"history": { "enabled": true, "storeAnswer": true, "storeQuestion": true }
```

- 文件位置：Linux/WSL `~/.local/state/model-advisor/history.jsonl`，Windows `%LOCALAPPDATA%\model-advisor\history.jsonl`；可用 `"path"` 指定绝对路径。目录 700、文件 600。
- 记录字段：时间、profile、模型、mode、耗时、成功/错误码、是否回退及原因、证据标签、约束数、问题、回答（`storeAnswer: false` 只存字节数）。
- 台账里会有你发给顾问的代码片段和回答，属敏感数据；写入失败不影响咨询本身。清空：删除该文件即可。

查看面板（中文界面，只读，仅绑定 127.0.0.1，会自动打开浏览器）：

```bash
npm run panel        # 或 node scripts/panel.mjs [--port 8471] [--history /abs/path] [--no-open]
```

面板展示各顾问调用次数、失败与回退、平均耗时，可按顾问/结果/类型筛选、搜索问题与回答，点开单条看完整建议。多个 Claude Code 会话共用同一份台账。

## 验证脚本

```bash
npm run check   # 语法检查
npm test        # 39 项核心测试（无需 SDK）
npm run smoke   # MCP stdio 握手 + 离线 mock 咨询

# 单次真实咨询（会向所选 provider 发请求，可能计费）
node scripts/consult-once.mjs examples/request.json
```

## 已验证（2026-09-13）

| 项目 | 结果 |
|---|---|
| `npm run check` | 17 个 JS/JSON 文件通过 |
| `npm test` | 45 / 45 通过 |
| `npm run smoke` | MCP initialize / tools/list / tools/call 通过 |
| `claude plugin validate` | 通过 |
| Claude Code `--plugin-dir` 加载，`list_advisors` + `consult_advisor` | 通过（真实第三方模型，经本地 OpenAI 兼容网关） |
| `/model-advisor:advisor profile=luna ...` Skill 入口 | 通过 |

## 安全说明

- 命令 Adapter 不是操作系统沙箱，只运行你信任的程序。
- 证据包与返回文本有有限的凭据模式检测，命中即阻断；这不是完备 DLP。
- 不自动重试、不静默切换 profile、不跨会话共享调用计数。
