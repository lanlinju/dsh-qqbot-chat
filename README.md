# dsh-qqbot-chat

一个 [dsh](https://github.com/deepseek-ai) 插件：把 QQ 官方机器人收到的消息变成 dsh 的一轮 agent，再把回答送回同一个 QQ 会话。

私聊一条消息、或者在群里说句话，背后的 agent 就在一个真实的工作目录里干活——读写文件、跑命令、调用工具，然后把结果回给你。

> 状态：**自用实验品**，已在真机跑通私聊与群聊往返。没有发布到 npm，接口随 dsh 的 rc 版本漂移。

## 它做什么

```
QQ 客户端 ──▶ QQ 网关（出站 WebSocket）
                  │  C2C_MESSAGE_CREATE / GROUP_MESSAGE_CREATE
                  ▼
            ┌─────────────┐   followup    ┌──────────────┐
            │   bridge    │ ────────────▶ │  dsh agent   │
            │ 会话↔Session │ ◀──────────── │  工具 / 沙箱  │
            └─────────────┘   whenIdle    └──────────────┘
                  │ 归一化 · 切分 · 被动回复
                  ▼
            POST /v2/users|groups/{id}/messages
```

- **一条 QQ 会话 = 一个 dsh Session**。私聊键 `c2c:<openid>`，群聊键 `group:<group_openid>`，各自独立上下文。
- **重启不丢上下文**。映射落在 `$DSH_HOME/qqbot-chat/sessions.json`，重启后接回原来的 Session；Session 已被 dsh 重新打开时直接认领，不重复创建。
- **回答原路返回**。优先用被动回复（挂原消息 `msg_id`），额度或时限用尽才降级为主动推送。
- **不把内部语法发给用户**。模型跑偏吐出的工具调用标记会被剔除，不落到 QQ 里。

## 特性

| 能力 | 说明 |
|---|---|
| 私聊 / 群聊 | 群聊支持「只回 @」与「每句都回」两种模式，见 `groupReply` |
| 会话复用 | 重启后接着上次聊，不新开 Session |
| 长回答 | 按语义切分，超长截断并附说明；代码块不切在中间 |
| 占位提示 | 一轮超过 `ackDelayMs` 先回一句「收到，正在处理…」，只发一次 |
| 权限档位 | 会话固定 `workspace-write` + 审批 `never`，见 [ADR-0003](docs/adr/0003-qq-channel-permission-tier.md) |
| 白名单 | `allowedUsers` / `allowedGroups`，空数组表示不限制 |
| 断线自愈 | identify/resume、心跳、按关闭码分流重连，受 `session_start_limit` 配额约束 |

## 快速开始

前置：dsh 已装好（`~/.dsh/profiles/web` 存在）、QQ 开放平台已建好机器人并拿到 `AppID` / `AppSecret`。

**1. 让宿主包可解析**

插件运行时 `import` 宿主包，但它们只装在 dsh 的 profile 里。用目录联接借过来（`node_modules/` 已 gitignore）：

```powershell
New-Item -ItemType Junction `
  -Path   D:\Dev\ts\dsh-plugins\dsh-qqbot-chat\node_modules\@deepseek-ai `
  -Target $HOME\.dsh\profiles\node_modules\@deepseek-ai

New-Item -ItemType Junction `
  -Path   $HOME\.dsh\profiles\node_modules\@lanlinju\dsh-qqbot-chat `
  -Target D:\Dev\ts\dsh-plugins\dsh-qqbot-chat
```

**2. 存凭据**

`$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  QQ_BOT_APP_SECRET: <你的 AppSecret>
```

配置里只写引用名 `QQ_BOT_APP_SECRET`，密钥本身不进仓库、不进 patch。

**3. 挂载**

`~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: qqbot-chat
      name: '@lanlinju/dsh-qqbot-chat'
      config:
        appId: 'YOUR_APP_ID'
        appSecretRef: QQ_BOT_APP_SECRET
```

`name` 必须是**包名**，写绝对路径会被当成裸 specifier，Windows 上直接解析失败。

**4. 启动**

```bash
dsh web --no-open
```

看到 `gateway READY` 就成了。加 `DSH_QQBOT_DEBUG=1` 会往 stderr 打 `[qqbot]` 轨迹。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | — | 必填，机器人 AppID |
| `appSecretRef` | — | 必填，凭据引用名 |
| `intents` | `33554432` | `1 << 25`，群 @ 与私聊共用 |
| `workspacePath` | `~/.dsh/qqbot-workspace` | agent 的工作目录，目录不存在会自动创建 |
| `maxConcurrent` | `1` | 跨会话并发的轮数上限 |
| `groupReply` | `all` | `all` 群里每句都回；`mention` 只回 @ |
| `allowedUsers` | `[]` | 私聊白名单（openid），空 = 不限制 |
| `allowedGroups` | `[]` | 群白名单（group_openid），空 = 不限制 |
| `ackDelayMs` | `8000` | 超时发占位提示，`0` 关闭 |
| `maxChars` | `1500` | 单条消息字数上限，被平台判定过长会自动减半 |
| `maxChunks` | `4` | 一轮最多几条消息 |
| `format` | `markdown` | `markdown` 或 `text` |
| `replyStyle` | `none` | 预留：`at` / `quote` |
| `apiBase` | `https://api.bot.qq.com` | OpenAPI 域名 |
| `logFrames` | `false` | 打印原始网关帧（很吵） |

## 用法

| 场景 | 行为 |
|---|---|
| 私聊 | 发什么都起一轮 |
| 群里 @ 它 | 起一轮（`content` 里的 `<@openid>` 会被剥掉） |
| 群里不 @ | `groupReply: all` 时起一轮；`mention` 时忽略 |
| 发 `/new` | 丢掉当前会话，下次消息开新的 |
| 它自己发的消息 | 一律忽略（`author.bot` 守卫，防自环） |

## 已知限制

- **群侧没有读隔离**。沙箱只挡写不挡读，群成员理论上能让 agent 读出机器上的文件并念回群里。见 [ADR-0004](docs/adr/0004-group-chat-enabled-permissions-deferred.md)。
- **`groupReply: all` 按消息计费**。群里每句话一次模型调用，热闹时段还会因串行队列积压。见 [ADR-0005](docs/adr/0005-group-reply-every-message.md)。
- **没接流式消息**。`stream_messages` 仅支持私聊且渲染语义未明，只在 `whenIdle()` 后一次性回。见 [#8](https://github.com/lanlinju/dsh-qqbot-chat/issues/8)。
- **不持久化时区/系统信息**。agent 在沙箱里，`pwsh` 之类依赖 .NET 的工具可能起不来，它会自己改用别的工具。
- 被动窗口过期、超长切分、主动降级三条分支有代码与单测，但**没有真机故障注入**。

## 开发

```
src/
  index.js     装配：token → api → replier → bridge → gateway，socket 交给 ctx.effect
  config.js    手写 Standard Schema 校验器，零依赖
  token.js     access_token 缓存 + 提前刷新 + 单飞，刷新失败退回旧 token
  api.js       /gateway/bot 与两个发消息端点，业务错误码统一抛 ApiError
  gateway.js   identify/resume、心跳、按关闭码分流重连、配额闸门
  bridge.js    QQ 会话 ↔ dsh Session、串行队列、/new、权限档位
  reply.js     Markdown 归一化、切分、被动优先 + 错误码驱动降级
  sessions.js  会话索引的落盘与版本迁移
```

零第三方运行时依赖，只用 `node:` 内置与全局 `WebSocket` / `fetch`。

**调试**：`DSH_QQBOT_DEBUG=1 dsh web` 会打印 apply、网关地址、原始事件字段、bridge 每一步、每次 OpenAPI 调用、dispose 路径。这个插件的日志默认进 dsh 的 UI 而不是 stdout，没有这层轨迹等于黑盒。

## 决策记录

| ADR | 结论 |
|---|---|
| [0001](docs/adr/0001-standard-schema-config-validation.md) | 配置用手写 Standard Schema 校验，不引 schemastery |
| [0002](docs/adr/0002-passive-first-error-driven-fallback.md) | 被动回复优先，按平台错误码降级，不按本地计时 |
| [0003](docs/adr/0003-qq-channel-permission-tier.md) | 权限档位 `workspace-write` + `never`；群聊部分已被 0004 取代 |
| [0004](docs/adr/0004-group-chat-enabled-permissions-deferred.md) | 群聊纳入 v1，读隔离风险已知未解 |
| [0005](docs/adr/0005-group-reply-every-message.md) | 群里每句都回（`groupReply: all` 为默认） |

更多：`GLOSSARY.md` 收概念域词汇，`docs/local-setup.md` 是本机装配细节，`docs/agents/` 是仓库协作约定。
