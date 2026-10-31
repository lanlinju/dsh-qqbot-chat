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

## 安装

装完**必须重启一次 dsh**——bundle 与配置只在启动时加载。

### 一、在 DSH 里装（推荐）

打开 **设置 → 插件 → 安装**，填这一行：

```
github:lanlinju/dsh-qqbot-chat
```

### 二、命令行

```bash
dsh plugin --profile web add github:lanlinju/dsh-qqbot-chat
```

`--profile` 照你平时那个写：网页端一般 `web`，桌面端 `desktop`。

⚠ `github:` 这种写法会让包管理器去 clone 仓库，**机器上得有 git**。没装 git 会报 `ERR_PNPM_GIT_FETCH_FAILED`，改用 tarball 直链，不经过 git：

```bash
dsh plugin --profile web add https://codeload.github.com/lanlinju/dsh-qqbot-chat/tar.gz/refs/heads/main
```

（上面两种方式都需要能访问这个仓库；仓库目前是 private，得先登录 GitHub。）

### 三、本地开发

改代码要即时生效时用目录联接，不要复制。`node_modules/` 已 gitignore：

```powershell
New-Item -ItemType Junction `
  -Path   D:\Dev\ts\dsh-plugins\dsh-qqbot-chat\node_modules\@deepseek-ai `
  -Target $HOME\.dsh\profiles\node_modules\@deepseek-ai

New-Item -ItemType Junction `
  -Path   $HOME\.dsh\profiles\node_modules\@lanlinju\dsh-qqbot-chat `
  -Target D:\Dev\ts\dsh-plugins\dsh-qqbot-chat
```

第一个联接是给**插件自己**用的：它运行时 `import` 宿主包，但那些包只装在 dsh 的 profile 里；Node 会把符号链接解析成真实路径，所以从仓库目录往上找找不到。

### 装完还差两步（漏了就是「QQ 上毫无反应」）

**1. 把包名登记成 bundle**

`dsh plugin add` 只写 `dependencies`，**不会**自动加进 `dsh.profile.bundles`。实测只加依赖时插件不加载、日志里连 `apply` 都没有。编辑 `~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": { "@lanlinju/dsh-qqbot-chat": "github:lanlinju/dsh-qqbot-chat" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@lanlinju/dsh-qqbot-chat"
      ]
    }
  }
}
```

**2. 给 appId**

bundle 层不带 appId（那是每台机器自己的东西）。二选一：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 这一层在 bundle 之后应用，会覆盖
- id: qqbot-chat
  config:
    appId: '1903967151'
```

或者启动前 `QQ_BOT_APP_ID=1903967151 dsh web`。

### 凭据

AppSecret 不进仓库、不进配置，只进 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  QQ_BOT_APP_SECRET: <你的 AppSecret>
```

配置里只写引用名（默认就是 `QQ_BOT_APP_SECRET`）。临时验证也可以直接 `QQ_BOT_APP_SECRET=xxx dsh web`——环境变量优先级高于文件。

### QQ 开放平台侧

| 项 | 要不要 | 说明 |
|---|---|---|
| AppID / AppSecret | **要** | 开发设置里拿，AppSecret 只显示一次 |
| 群消息能力 | **要** | 群里要能收到消息，得在机器人能力里开；开了之后 @ 也走 `GROUP_MESSAGE_CREATE` |
| **IP 白名单** | **要** | 调 OpenAPI 的**出口 IP** 要加进白名单，否则 HTTP 调用被平台拒绝（表现是发不出消息，但网关连着） |
| 回调地址 / 事件订阅 URL | **不要** | 本插件走出站 WebSocket 长连接，不需要公网入口；那个框是给 webhook 模式的 |

IP 白名单这一步最容易漏，因为**网关能连上、日志一片正常**，只是发消息被拒。报错会带 `401` 或权限相关的 `err_code`，`DSH_QQBOT_DEBUG=1` 下能直接看到。

## 启动与验证

```bash
dsh web --no-open
```

看到 `gateway READY` 就成了。然后：

1. **私聊**机器人发一句 → 几秒内回话；
2. **群里**发一句（`groupReply` 默认 `all`，不用 @）；
3. 发 `/new` → 回「已开启新会话。」。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` | 环境变量 `QQ_BOT_APP_ID` | 机器人 AppID |
| `appSecretRef` | `QQ_BOT_APP_SECRET` | 凭据引用名 |
| `intents` | `33554432` | `1 << 25`，群 @ 与私聊共用 |
| `workspacePath` | `~/.dsh/qqbot-workspace` | agent 的工作目录，不存在会自动创建 |
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

## 排查

先开 `DSH_QQBOT_DEBUG=1`，它会把 `apply`、网关地址、原始事件字段、每次 OpenAPI 调用、dispose 全打到 stderr。默认日志进 dsh 的 UI 而不是 stdout，没有这层轨迹等于黑盒。

| 症状 | 先查什么 |
|---|---|
| QQ 上毫无反应，日志里没有 `[qqbot] apply called` | 包名没进 `dsh.profile.bundles`；或版本被判不兼容（`disabling profile plugin row`） |
| 网关 `READY` 但发消息被拒 | 平台侧的 **IP 白名单** |
| 群里 @ 不回，但日志有 `GROUP_MESSAGE_CREATE` | `groupReply` 与 `mentions[].is_you` 判定 |
| 回答是一串 `<｜｜DSML｜｜invoke>` | agent 没挂 preset，没有工具 |
| 报 `all tools cannot be deferred` | 接回了一个「无工具时代」的旧会话，删掉索引条目即可 |
| 日志里 `40054005` 然后成功 | 占位与正文抢 `msg_seq`，新版本已修 |
| 侧边栏堆出一串同名会话 | 旧版本每次 resume 失败都新建，清 `workspace.json` 里多余的 sessionIds |

## 已知限制

- **群侧没有读隔离**。沙箱只挡写不挡读，群成员理论上能让 agent 读出机器上的文件并念回群里。见 [ADR-0004](docs/adr/0004-group-chat-enabled-permissions-deferred.md)。
- **`groupReply: all` 按消息计费**。群里每句话一次模型调用，热闹时段还会因串行队列积压。见 [ADR-0005](docs/adr/0005-group-reply-every-message.md)。
- **没接流式消息**。`stream_messages` 仅支持私聊且渲染语义未明，只在 `whenIdle()` 后一次性回。见 [#8](https://github.com/lanlinju/dsh-qqbot-chat/issues/8)。
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

`package.json` 里的 `dsh.bundle.patch` 指向根目录的 `cordis.patch.yml`——那一层负责把插件行 `insert` 进 profile，所以装完不需要手写 patch 才能出现。

## 决策记录

| ADR | 结论 |
|---|---|
| [0001](docs/adr/0001-standard-schema-config-validation.md) | 配置用手写 Standard Schema 校验，不引 schemastery |
| [0002](docs/adr/0002-passive-first-error-driven-fallback.md) | 被动回复优先，按平台错误码降级，不按本地计时 |
| [0003](docs/adr/0003-qq-channel-permission-tier.md) | 权限档位 `workspace-write` + `never`；群聊部分已被 0004 取代 |
| [0004](docs/adr/0004-group-chat-enabled-permissions-deferred.md) | 群聊纳入 v1，读隔离风险已知未解 |
| [0005](docs/adr/0005-group-reply-every-message.md) | 群里每句都回（`groupReply: all` 为默认） |

更多：`GLOSSARY.md` 收概念域词汇，`docs/local-setup.md` 是本机装配细节，`docs/agents/` 是仓库协作约定。
