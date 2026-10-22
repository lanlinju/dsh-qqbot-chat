# QQ 官方机器人 API 调研（无 SDK 实现导向）

调研对象：QQ 机器人官方文档 `bot.q.qq.com/wiki`（api-v2）+ QQ 开放平台 `q.qq.com`。
调研时间：2026-10-23。文档站当前版本号（资源路径可见）：`v1.42.0`。
目标读者：只用 Node 内建能力（全局 `WebSocket` / `fetch` / `node:zlib`）实现 QQ Bot 网关桥接的开发者。

标注约定：

- **文档明确**：官方文档原文写死的结论，可直接照抄实现。
- **由文档推断**：文档未直接写，但由多处原文可推出唯一合理结论。
- **未知**：文档沉默、自相矛盾或语焉不详，**不要猜**。

> 重要背景：本页文档在 2026 年做过一次结构性重写（`autogen/` 目录下的接口页是逐接口生成的权威 schema）。旧版散落在 `server-inter/group/`、`server-inter/user/` 目录页里的接口描述已被清空，只剩「功能设置项」说明，真正的字段表在 `autogen/api/*.post.html`。查字段时请直接看 autogen 页。

---

## 1. Auth：getAppAccessToken 与 identify 用的 token

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html

### 1.1 端点

| 项 | 值 | 标注 |
|---|---|---|
| Method | `POST` | 文档明确 |
| 官方 URL | `https://api.bot.qq.com/app/getAppAccessToken` | 文档明确 |
| 旧/兼容 URL | `https://bots.qq.com/app/getAppAccessToken` | 由文档推断（文档已全面改写为 `api.bot.qq.com`；实测两个域名都返回同一结构） |
| Content-Type | `application/json` | 文档明确 |

> 实测（2026-10-23，用假 appId 探测）：两个域名均 `HTTP 200`，body 均为 `{"code":100007,"message":"appid invalid"}`。说明 `bots.qq.com` 仍然可用但已不是文档主推域名。**实现建议**：默认用 `api.bot.qq.com`，把 host 做成可配置项，遇到 DNS/证书问题时回退 `bots.qq.com`。

### 1.2 请求体

```json
{ "appId": "APPID", "clientSecret": "CLIENTSECRET" }
```

- `appId` string 必填；`clientSecret` string 必填。—— 文档明确
- 注意字段是驼峰 `appId` / `clientSecret`，不是 `app_id`。—— 文档明确

### 1.3 响应

成功：

```json
{ "access_token": "ACCESS_TOKEN", "expires_in": "7200" }
```

- `access_token` string —— 文档明确
- `expires_in` number，单位秒，文档说「目前是 7200 秒之内的值」；**示例里却是字符串 `"7200"`**。—— 文档明确（类型不一致，实现必须做 `Number()` 兜底）

失败（**HTTP 仍是 200**）：

```json
{ "code": 100007, "message": "appid invalid" }
```

- 文档明确：「该接口的业务错误通过响应体的 `code` 返回，即使调用失败，HTTP 返回码仍为 200。请优先依据 `code` 判断」。
- 业务错误码：`100001` Too many requests；`100007` appid invalid（含机器人被封禁/已删除）；`100016` invalid appid or secret；`10004` 机器人不存在。—— 文档明确

### 1.4 TTL 与刷新策略

- 生命周期默认 `7200` 秒（2 小时）。—— 文档明确
- 「每次请求不会刷新新的 `access_token`，在有效期内重复获取会返回相同的值」。—— 文档明确
- 「在上一个 `access_token` 接近过期时间 `60` 秒内，获取 `access_token` 时，会获得一个新的 `access_token`，老的 `access_token` 在这个 60 秒内仍然有效」。—— 文档明确
- 官方建议：服务端定时刷新。—— 文档明确

实现含义：**不要每次发消息都换 token**；缓存 + 提前刷新（例如 TTL 剩 < 60s 或按 `expires_in * 0.9` 触发）。重复请求在有效期内是幂等的，所以并发时可以用单飞（single-flight）保护，但即使打多次也不会踢掉旧 token。

### 1.5 两个 token 分别用在哪

| 场景 | 用哪个 | Header / 字段格式 | 标注 |
|---|---|---|---|
| HTTP OpenAPI（发消息、上传、/gateway） | `access_token` | `Authorization: QQBot {ACCESS_TOKEN}` | 文档明确 |
| WebSocket `op=2 identify` 的 `d.token` | `access_token` | `"QQBot {AccessToken}"` | 文档明确 |
| WebSocket `op=6 resume` 的 `d.token` | 同上 | 同上 | 由文档推断（resume 示例只写 `my_token`，但语义与 identify 同一凭证） |
| 旧 Bot Token（`Bot {appid}.{app_token}`） | **已废弃** | —— | 文档明确（首页：「Token 的鉴权方式已废弃，请使用更安全的 Access Token 鉴权方式」） |

**文档矛盾（需注意）**：`interface-framework/reference.html` 仍残留一句「`token` 是创建机器人的时候分配的，格式为 `Bot {appid}.{app_token}`」，与 `event-emit/websocket.html` 的「格式为 `QQBot {AccessToken}`」直接冲突。以 `QQBot {AccessToken}` 为准（多页一致 + 首页废弃声明）。—— 文档明确（冲突已判定）

结论：**只有一个 token**。`getAppAccessToken` 拿到的就是 identify 里用的那个，前缀固定 `QQBot `（大写 Q，中间一个空格）。

---

## 2. Gateway：/gateway、/gateway/bot、shards、intents 位表

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html
- https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html

### 2.1 两个取址接口

`GET /gateway` —— 只返回一个地址：

```json
{ "url": "wss://api.bot.qq.com/websocket/" }
```

`GET /gateway/bot` —— 返回地址 + 分片建议 + 建连配额：

```json
{
  "url": "wss://api.bot.qq.com/websocket",
  "shards": 1,
  "session_start_limit": {
    "total": 1000,
    "remaining": 1000,
    "reset_after": 86400000,
    "max_concurrency": 1
  }
}
```

- `url` string：WebSocket 连接地址（注意示例里带/不带尾斜杠都出现过）。—— 文档明确
- `shards` int：**建议的**分片数。—— 文档明确
- `session_start_limit.total`：每 24 小时可创建 Session 数。—— 文档明确
- `.remaining`：目前还可创建数；「每个机器人创建的连接数不能超过 `remaining`」。—— 文档明确
- `.reset_after`：重置计数剩余时间（ms）。—— 文档明确
- `.max_concurrency`：**每 5s 可以创建的 Session 数**。—— 文档明确

**鉴权**：两个接口都要 `Authorization: QQBot {ACCESS_TOKEN}`。文档接口页只给了 `GET /gateway`，没写 header 表，但 `api-use.html` 说「每次调用 https 的 openapi 开放接口请求的时候，需要在 header 内引入 access_token」。实测无 token 时返回：

```json
{"message":"鉴权失败","code":11201,"err_code":40012001,"trace_id":"..."}  // HTTP 401
```

—— 由文档推断（鉴权要求）/ 实测确认（错误形态）

> 实现提示：401 时不要无限重试，应先重新取 token；错误体里同时有 `code` 和 `err_code` 两个编号体系（`11201` 与 `40012001`），不要只认一个。

### 2.2 shards 语义

- identify 的 `shard` 是 `[shard_id, num_shards]` 两元素数组；`[0,4]` 表示共 4 片、当前是第 0 片，需要再建 `[1,4] [2,4] [3,4]` 才能收全事件。—— 文档明确
- 「若无需分片，使用 `[0, 1]` 即可」。—— 文档明确
- 分片哈希规则：`shard_id = (guild_id >> 22) % num_shards`。—— 文档明确
- 分片「完全由用户控制，并且不需要在单独的连接之间进行状态共享」。—— 文档明确

**关键点**：`shards` 是「建议值」，不是强制值。绝大多数单机桥接用 `[0,1]` + `intents` 里不含频道事件即可。

**未知**：群聊 / C2C 事件没有 `guild_id`，文档未说明这类事件在 `num_shards > 1` 时如何分配。→ 见「待确认」。

### 2.3 Intents 位表（官方原表 + 十进制值）

| 名称 | 位移 | 十进制 | 覆盖事件 | 限制 |
|---|---|---|---|---|
| `GUILDS` | `1 << 0` | `1` | GUILD_CREATE / UPDATE / DELETE，CHANNEL_CREATE / UPDATE / DELETE | 基础事件，默认有权限 |
| `GUILD_MEMBERS` | `1 << 1` | `2` | GUILD_MEMBER_ADD / UPDATE / REMOVE | 基础事件 |
| `GUILD_MESSAGES` | `1 << 9` | `512` | MESSAGE_CREATE / MESSAGE_DELETE | **仅私域** |
| `GUILD_MESSAGE_REACTIONS` | `1 << 10` | `1024` | MESSAGE_REACTION_ADD / REMOVE | 特殊事件需申请 |
| `DIRECT_MESSAGE` | `1 << 12` | `4096` | DIRECT_MESSAGE_CREATE / DELETE | 特殊事件需申请 |
| `GROUP_AND_C2C_EVENT` | `1 << 25` | `33554432` | **C2C_MESSAGE_CREATE、GROUP_AT_MESSAGE_CREATE**、FRIEND_ADD/DEL、C2C_MSG_REJECT/RECEIVE、GROUP_ADD_ROBOT/DEL_ROBOT、GROUP_MSG_REJECT/RECEIVE | 特殊事件需申请 |
| `INTERACTION` | `1 << 26` | `67108864` | INTERACTION_CREATE | 特殊事件需申请 |
| `MESSAGE_AUDIT` | `1 << 27` | `134217728` | MESSAGE_AUDIT_PASS / REJECT | 特殊事件需申请 |
| `FORUMS_EVENT` | `1 << 28` | `268435456` | 论坛事件 | **仅私域** |
| `AUDIO_ACTION` | `1 << 29` | `536870912` | AUDIO_START / FINISH / ON_MIC / OFF_MIC | 特殊事件需申请 |
| `PUBLIC_GUILD_MESSAGES` | `1 << 30` | `1073741824` | AT_MESSAGE_CREATE、PUBLIC_MESSAGE_DELETE | 基础事件（公域消息） |

—— 文档明确（整表逐项来自 event-emit.html）

**三个必须记住的坑**：

1. **`GUILD_MESSAGES` 是 `1<<9`（512），不是 Discord 的 `1<<0`。** `1<<0` 是 `GUILDS`。照抄 Discord 会直接收到 4013/4014。
2. **`GROUP_AT_MESSAGE_CREATE` 和 `C2C_MESSAGE_CREATE` 没有独立位**，两者共用 `GROUP_AND_C2C_EVENT = 1<<25`。想只要群 @ 或只要 C2C 是做不到的，只能整位订阅后按 `t` 过滤。—— 文档明确
3. 文档示例 `intents: 513` 正是 `1 + 512`（`GUILDS | GUILD_MESSAGES`），可作校验基准。

### 2.4 私域 / 公域 限制

- `GUILD_MESSAGES (1<<9)`：原文注释「消息事件，仅 *私域* 机器人能够设置此 intents」。—— 文档明确
- `FORUMS_EVENT (1<<28)`：同样标注「仅 *私域* 机器人能够设置」。—— 文档明确
- `PUBLIC_GUILD_MESSAGES (1<<30)`：原文注释「此为公域的消息事件」。—— 文档明确
- **未知**：文档没有给出「私域 / 公域」的正式定义与判定方式（推测与机器人是否上架公开服务有关，但无原文）。→ 见「待确认」。

### 2.5 群 @ 消息 / C2C 私聊需要哪些 intents

| 目标 | 必需 intents | 十进制 |
|---|---|---|
| 群内 @ 机器人 | `GROUP_AND_C2C_EVENT` (`1<<25`) | `33554432` |
| C2C 单聊 | `GROUP_AND_C2C_EVENT` (`1<<25`) | `33554432` |
| 两者都要 | 同上，一个位就够 | `33554432` |

—— 文档明确（事件页 `<event>.Intent` 字段直接写明 `GROUP_AND_C2C_EVENT (1<<25)`）

**不需要** `PUBLIC_GUILD_MESSAGES (1<<30)`——那是频道 @ 消息（`AT_MESSAGE_CREATE`），与群 / 单聊无关。订阅它只会多收频道事件、多耗配额。**因此常见建议「intents 必须含 1<<25 | 1<<30」对本场景是错的**，只需 `1<<25`。

### 2.6 权限与订阅失败行为

- 「除了 `GUILDS`，`PUBLIC_GUILD_MESSAGES`，`GUILD_MEMBERS` 事件是基础的事件，默认有权限订阅之外，其他的特殊事件，都需要经过申请才能够使用」。—— 文档明确
- 「如果在鉴权的时候传递了无权限的 `intents`，`websocket` 会报错，并直接关闭连接」。—— 文档明确
- 「如果拥有的某个特殊事件类型的权限被取消，则在当前连接上不会报错，但是将不会收到对应的事件类型，如果重新连接，则报错」。—— 文档明确

这条对实现影响极大：**intents 配错不是「少收事件」，而是「连不上」**。所以 `intents` 必须可配置，并且连不上时要能从 close code 区分 4013/4014。

---

## 3. 心跳 / 重连：opcode 表、identify、resume

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html

### 3.1 完整 opcode 表

| code | 名称 | 方向 | 描述 | 标注 |
|---|---|---|---|---|
| `0` | Dispatch | Receive | 服务端推送事件 | 文档明确 |
| `1` | Heartbeat | Send/Receive | 客户端或服务端发送心跳 | 文档明确 |
| `2` | Identify | Send | 客户端发送鉴权 | 文档明确 |
| `6` | Resume | Send | 客户端恢复连接 | 文档明确 |
| `7` | Reconnect | Receive | 服务端通知客户端重新连接 | 文档明确 |
| `9` | Invalid Session | Receive | identify / resume 参数有错时返回 | 文档明确 |
| `10` | Hello | Receive | 建连后网关下发的第一条消息 | 文档明确 |
| `11` | Heartbeat ACK | Receive/Reply | 心跳成功回执 | 文档明确 |
| `12` | HTTP Callback ACK | Reply | **仅 webhook 模式**回包 | 文档明确 |
| `13` | 回调地址验证 | Receive | **仅 webhook 模式**验证 | 文档明确 |

**`3` / `4` / `5` / `8` 在 QQ 文档中不存在**（Discord 的 Presence Update / Voice State / Voice Server / Request Guild Members 在 QQ 侧没有定义）。解析时遇到未知 op 应忽略而不是崩。—— 文档明确（表里没有即未定义）

### 3.2 Hello 与 heartbeat_interval

```json
{ "op": 10, "d": { "heartbeat_interval": 45000 } }
```

- 单位**毫秒**，示例值 `45000`（45 秒）。—— 文档明确
- 语义：客户端应按此周期主动发 `op=1`。—— 文档明确
- op 1 标注为 `Send/Receive`，即服务端也可能发心跳，但**服务端主动发心跳的触发条件、以及客户端多久没收到 ACK 该判定断线，文档未定义**。—— 未知

### 3.3 Identify（op=2）

```json
{
  "op": 2,
  "d": {
    "token": "QQBot {AccessToken}",
    "intents": 33554432,
    "shard": [0, 1],
    "properties": {
      "$os": "linux",
      "$browser": "my_library",
      "$device": "my_library"
    }
  }
}
```

- `token`：`"QQBot {AccessToken}"`。—— 文档明确
- `intents`：见 §2.3。—— 文档明确
- `shard`：`[id, num]`，无分片用 `[0,1]`。—— 文档明确
- `properties`：「目前无实际作用，可以按照自己的实际情况填写，也可以留空」。—— 文档明确（可传 `{}` 或省略）

成功后收到 READY（`op=0, t="READY"`）：

```json
{
  "op": 0,
  "s": 1,
  "t": "READY",
  "d": {
    "version": 1,
    "session_id": "082ee18c-0be3-491b-9d8b-fbd95c51673a",
    "user": { "id": "6158878435714165", "username": "群pro测试机器人", "bot": true },
    "shard": [0, 0]
  }
}
```

- `d.session_id` 是后续 resume 的唯一凭据，**必须持久化到内存**（跨进程重启则无法 resume）。—— 文档明确
- `d.shard` 回显的是 `[0,0]`（注意示例与请求的 `[0,4]` 不一致，不要拿它做校验）。—— 文档明确（示例如此）

### 3.4 Heartbeat（op=1）

```json
{ "op": 1, "d": 251 }
```

- `d` = 客户端收到的**最新** `s`；首次连接（还没收到任何 `s`）传 `null`。—— 文档明确
- 收到 `{"op": 11}` 即 ACK。—— 文档明确

### 3.5 Resume（op=6）

```json
{
  "op": 6,
  "d": { "token": "QQBot {AccessToken}", "session_id": "session_id_i_stored", "seq": 1337 }
}
```

- `seq` = 收到事件的 `s` 字段；「推荐开发者在处理过事件之后记录下 `s`」，网关会自动补发该 seq 之后的事件。—— 文档明确
- 补发完成后下发 `RESUMED`：`{ "op": 0, "s": 2002, "t": "RESUMED", "d": "" }`。—— 文档明确
- 「断开之后**短时间内**重连会补发中间遗漏的事件」——**「短时间」的具体时长文档未给**。—— 未知

### 3.6 什么时候必须重新 identify

依据 WebSocket 错误码表的「是否可以重试 RESUME / IDENTIFY」两列（文档明确）：

| code | 含义 | 可 resume | 可 identify | 处置 |
|---|---|---|---|---|
| `4001` | 无效 opcode | 否 | 否 | 修代码，不要重连风暴 |
| `4002` | 无效 payload | 否 | 否 | 修代码 |
| `4006` | 无效 session id，无法 resume | 否 | **是** | **改发 identify** |
| `4007` | seq 错误 | 否 | **是** | **改发 identify** |
| `4008` | 发送 payload 过快 | 是 | 是 | 重连 + 遵守频控 |
| `4009` | 连接过期 | **是** | 是 | **重连后 resume** |
| `4010` | 无效 shard | 否 | 否 | 检查 `[id,num]` |
| `4011` | 需处理的 guild 过多 | 否 | 否 | 增加分片 |
| `4012` | 无效 version | 否 | 否 | 检查 `d.version` |
| `4013` | 无效 intent | 否 | 否 | 检查 intents 位 |
| `4014` | intent 无权限 | 否 | 否 | 去管理端申请权限 |
| `4900~4913` | 内部错误 | 否 | **是** | 重连 identify |
| `4914` | 机器人已下架，只允许沙箱 | 否 | 否 | 检查环境，停止重连 |
| `4915` | 机器人已封禁 | 否 | 否 | 停止重连 |

文档给出的简化逻辑（原文）：
- 「4009 可以重新发起 resume」
- 「4914，4915 不可以连接」
- 「其他错误，请重新发起 identify」

**推论**：可 resume 的前提是同时具备 `session_id` 和 `seq`。任一缺失（例如进程重启、从未收到 READY、收到过 `op=9 Invalid Session`）就必须 identify。—— 由文档推断

**注意**：`op=9 Invalid Session` 的 `d` 载荷形状（是否带布尔值表示可否 resume）文档未给出，表里也没有对应错误码说明。→ 见「待确认」。

---

## 4. 压缩：是否支持 zlib-stream

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/reference.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/opcode.html

### 4.1 结论

**未知（文档完全未提及）**。

我在以下页面全文检索了 `zlib` / `compress` / `压缩` / `gzip` / `deflate`，**零命中**：
`event-emit/websocket.html`、`interface-framework/reference.html`、`interface-framework/event-emit.html`、`api-call-guide.html`、`access-token.html`、`getting-started.html`。

同时可以确认的**否定证据**：

- 文档给的连接地址是裸 `wss://api.bot.qq.com/websocket/`，**没有任何 query 参数**（对比 Discord 的 `?v=10&encoding=json&compress=zlib-stream`）。—— 文档明确
- 文档的 payload 示例全是 JSON 文本，`{"op":10,"d":{"heartbeat_interval":45000}}`。—— 文档明确
- 所有 opcode 表、错误码表里没有任何与压缩/编码协商相关的项。—— 文档明确
- 错误码表里没有类似 `4003 Not authenticated` / `4004` 的编码协商错误位，说明协议里不存在这条协商路径。—— 由文档推断

### 4.2 因此实现上怎么做

**默认按纯文本 JSON 帧处理**：`ws.onmessage` 里 `typeof ev.data === 'string'` 直接 `JSON.parse`。这是与文档示例一致的唯一有据可依的做法。—— 由文档推断

**但要防御二进制帧**：全局 `WebSocket`（undici 实现）在服务端发 binary frame 时会给你 `Blob`（Node 18/20）或 `ArrayBuffer`（Node 22+ 视 `binaryType` 而定）。稳妥写法：

```js
ws.binaryType = 'arraybuffer';           // 避免拿到 Blob 还要 await
// onmessage:
if (typeof data === 'string') return JSON.parse(data);
const buf = Buffer.from(data);           // ArrayBuffer -> Buffer
// 此时才需要判断压缩格式
```

**如果**将来确认支持 `zlib-stream`，Node 侧的正确消费方式是 **`zlib.createInflate()` 流式解压**，不是 `inflateSync`：

- `zlib-stream` 的语义（Discord 沿用的一套）是：每条压缩帧以 4 字节大端 `0x00 0x00 0xff 0xff`（`Z_SYNC_FLUSH` 标记）结尾，一个「逻辑消息」可能跨多个 WS frame，因此必须维护**一个长生命周期的 inflate 实例**，把每个 frame 的 payload `write()` 进去，在 `data` 事件里拿到解压后的 JSON 文本。
- `inflateSync` 只适用于「每一帧都是独立完整 zlib 流」的场景；`zlib-stream` 恰恰不是独立流（共享字典/上下文），逐帧 `inflateSync` 会在第二帧开始报 `invalid distance too far back` 之类的错。

—— 由文档推断（协议细节全部来自通用 zlib-stream 约定，QQ 文档未定义）

**4 字节帧分隔符在 QQ 文档中没有记载**。—— 未知

### 4.3 建议

实现里**不要**主动发 `compress=zlib-stream` 之类的参数（文档没定义，可能被忽略或导致握手异常）。但保留一个 `onBinaryFrame` 分支：先尝试 `JSON.parse(buf.toString('utf8'))`，失败再走 `createInflate` 兜底。这样即使平台某天默认开压缩也不会静默丢事件。

---

## 5. 发消息：/v2/users 与 /v2/groups 全字段、被动窗口、msg_seq、主动配额

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html

### 5.1 基础信息

| 项 | C2C | 群聊 |
|---|---|---|
| Path | `POST /v2/users/{user_openid}/messages` | `POST /v2/groups/{group_openid}/messages` |
| 路径参数 | `user_openid` string 必填 | `group_openid` string 必填 |
| 接口频控 | **100 QPS**（含主动+被动所有类型） | **100 QPS** |
| Header | `Authorization: QQBot {ACCESS_TOKEN}` + `Content-Type: application/json` | 同左 |

—— 文档明确

### 5.2 请求体字段（两接口对比）

| 字段 | 类型 | C2C | 群聊 | 说明 | 标注 |
|---|---|---|---|---|---|
| `msg_type` | integer | ✅ 0/2/6/7 | ✅ 0/2/7 | 决定哪个内容字段生效。**C2C 多一个 `6`=输入中状态；群聊没有 6** | 文档明确 |
| `content` | string | ✅ | ✅ | `msg_type=0` 时是全文。**传了 `markdown` 后此字段必须为空** | 文档明确 |
| `markdown` | object | ✅ | ✅ | `msg_type=2` 时必填。填了它则 `content`/`ark` 必须全空 | 文档明确 |
| `keyboard` | object | ✅ | ✅ | 短形式 `{id}`，长形式 `{content:{rows:[...]}}` | 文档明确 |
| `msg_id` | string | ✅ | ✅ | 被动回复的消息 ID，取事件的 `d.id` | 文档明确 |
| `event_id` | string | ✅ | ✅ | 被动回复的事件 ID，取事件**最外层** `id`。与 `msg_id` 二选一 | 文档明确 |
| `msg_seq` | integer | ✅ | ✅ | 回复序号，与 `msg_id` 联合使用，**不填默认 1** | 文档明确 |
| `media` | object | ✅ | ✅ | `msg_type=7` 时填 `{file_info}` | 文档明确 |
| `message_reference` | object | ✅ | ✅ | 引用回复 `{message_id}` | 文档明确 |
| `is_wakeup` | boolean | ✅ | ❌ | 互动召回消息；与 `msg_id`/`event_id` 互斥 | 文档明确 |
| `input_notify` | object | ✅ | ❌ | `msg_type=6` 时用 `{input_type:1, input_second}`，最长 60s | 文档明确 |
| `ark` | — | ❌ | ❌ | 本版两接口请求体均**未列出** `ark` 字段（只有错误码提到 ARK 模板权限） | 文档明确 |
| `stream` | — | ❌ | ❌ | **发送接口没有 `stream` 字段**，流式是独立接口（见 §6） | 文档明确 |

`event_id` 支持的事件集合（两接口不同，容易踩）：

- C2C：`INTERACTION_CREATE`、`C2C_MSG_RECEIVE`、`FRIEND_ADD`。—— 文档明确
- 群聊：`INTERACTION_CREATE`、`GROUP_ADD_ROBOT`、`GROUP_MSG_RECEIVE`。—— 文档明确
- **`GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` 不在 `event_id` 支持列表里**，这两种事件必须用 `msg_id` 回复。→ 由文档推断（列表未列即不支持，且对应错误码 `40034027 该事件不支持回复消息`）

`MessageMarkdown` 子结构：

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `content` | string | Markdown 内容 | 文档明确 |
| `template_id` | integer | **【已废弃】** | 文档明确 |
| `custom_template_id` | string | **【已废弃】** | 文档明确 |
| `force_verify_image_resource` | boolean | true 时图片转存失败会报错而非静默降级，默认 false | 文档明确 |

`MessageReference.message_id` 来源（引用回复时）：
- 非机器人发的消息：从事件 `message_scene.ext` 数组里的 `msg_idx` 取。—— 文档明确
- 机器人自己发的消息：从发消息响应 `ext_info.ref_idx` 取。—— 文档明确

### 5.3 响应

```json
{
  "id": "ROBOT1.0_xxxx",
  "timestamp": "2026-07-21T10:00:00+08:00",
  "ext_info": { "ref_idx": "REFIDX_xxxx==" }
}
```

- `id` string：消息 ID，用于撤回。—— 文档明确
- `timestamp` string：RFC3339 **东八区**。—— 文档明确
- `ext_info.ref_idx` string：引用消息索引。—— 文档明确

### 5.4 被动回复窗口（重点）

| 场景 | 有效期 | 每条消息可回复次数 | 标注 |
|---|---|---|---|
| 单聊（C2C） | **60 分钟** | **4 次** | 文档明确（overview） |
| 群聊 | **5 分钟** | **5 次** | 文档明确 |
| 频道 | 5 分钟 | —（未给次数） | 文档明确 |

**文档内部矛盾（必须记录）**：C2C 发送接口页顶部的规则写「被动消息有效时间 **60 分钟**，每个消息最多回复 **4 次**」，但同一页 `msg_id` 字段的描述写「…的 `d.id` 获取，**5 分钟内有效**」。两处冲突。

处置建议：**按 60 分钟设计，但按 5 分钟兜底**（即把 5 分钟当成软目标、把 60 分钟当成硬上限）。理由：字段级描述大概率是从群聊页复制粘贴的残留；但保守实现不会因为乐观而失败——只要在 5 分钟内回复，两种解读都满足。—— 由文档推断

相关错误码：`40034005 回复消息msg_id已过期`、`40034128 被动回复时间或次数超限`、`304103 消息ID已过期，不能回复`。—— 文档明确

### 5.5 msg_seq 规则

原文（两接口一致）：「回复消息的序号，与 `msg_id` 联合使用，避免相同消息 id 回复重复发送，**不填默认是 1**。**相同的 `msg_id + msg_seq` 重复发送会失败**。」—— 文档明确

overview 页补充：「被动回复时，相同的 `msg_id + msg_seq` 重复发送会失败，可**递增** `msg_seq` 实现对同一消息的多次回复。」—— 文档明确

对应错误码：`40054005 消息被去重 / 请确保每次请求使用不同的 msgseq 值`。—— 文档明确

**未知**：文档只说了「递增」，**没有规定步长必须为 1**，也没说 `msg_seq` 是全局还是按 `msg_id` 计数。→ 见「待确认」

实现建议（由文档推断）：以 `msg_id` 为 key 维护计数器，`Map<msg_id, nextSeq>`，每次发送 `seq = nextSeq++`，起始 1；对同一 `msg_id` 的第 N 次回复用 `N`。即使步长不必为 1，从 1 连续递增永远安全。

### 5.6 主动消息配额

C2C（HTTP 接口）：

| 认证类型 | Bot 维度 | 单关系维度 | 每日上限 |
|---|---|---|---|
| 企业认证 | 10/qps | 20/qpm | 1000 条/用户 |
| 个人认证 | 10/qps | 20/qpm | 1000 条/用户 |
| 未认证 | 5/qps **且** 30/qpm | 20/qpm | 1000 条/用户 |

群聊（HTTP 接口）：

| 认证类型 | Bot 维度 | 单关系维度 | 每日上限 |
|---|---|---|---|
| 企业认证 | 60/qpm | 20/qpm | 1000 条/群 |
| 个人认证 | 60/qpm | 20/qpm | 1000 条/群 |
| 未认证 | 30/qpm | 20/qpm | 1000 条/群 |

—— 文档明确

补充规则：

- 「QQ 用户可以在 QQ 客户端主动设置是否接收机器人发送的主动消息，如果设置了关闭，主动消息一律发送失败」。—— 文档明确
- 互动召回消息 `is_wakeup=true`：用户主动对话后 30 天内，分 4 个周期（当天 / 1-3 天 / 3-7 天 / 7-30 天），**每周期 1 条**。—— 文档明确
- 相关错误码：`40034100 主动消息发送超过频控限制`、`40034105 主动消息发送失败，无权限`、`40054013 用户拒收消息`、`40034122 召回消息已达区间上限`。—— 文档明确

**注意单位陷阱**：C2C 的「未认证」是 `5/qps 且 30/qpm`，群聊全是 `/qpm`（每分钟）。写限流器时两者不能共用一套桶。

### 5.7 其他发送相关规则

- 撤回：发送超过 **2 分钟**不可撤回。—— 文档明确
- `40054010 不允许发送URL`：纯文本消息里带 URL 可能被拒。—— 文档明确（错误码存在即说明有该限制，具体触发条件未知）
- `40054007 消息长度超限`、`40054018 消息过长或异常`。—— 文档明确（阈值未知，见 §10）

---

## 6. 流式消息

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html

### 6.1 是不是独立接口

是。**不是**在发消息接口上加 `stream` 字段，而是单独一个端点：

`POST /v2/users/{user_openid}/stream_messages` —— 文档明确
频控：**50 QPS** —— 文档明确

### 6.2 请求字段

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `input_mode` | string | `append`（默认）：`content_raw` 拼接到 Pending；`replace`：`content_raw` 为当前全量正文，**必须以上游已下发前缀 SentContent 开头** | 文档明确 |
| `input_state` | integer | **`1`=生成中，`10`=生成结束** | 文档明确 |
| `index` | integer | 分片序号，**从 0 递增** | 文档明确 |
| `content_type` | string | `text` 或 `markdown` | 文档明确 |
| `content_raw` | string | 内容正文 | 文档明确 |
| `event_id` | string | 被动回复事件 ID（与 `msg_id` 二选一） | 文档明确 |
| `msg_id` | string | 被动回复消息 ID（与 `event_id` 二选一） | 文档明确 |
| `stream_msg_id` | string | 流式消息 ID。**第一条由服务端生成并返回**，后续分片必须携带上一片返回的值 | 文档明确 |
| `msg_seq` | integer | 消息序号，用于去重 | 文档明确 |
| `is_wakeup` | boolean | 召回消息；true 时不校验 `msg_id`/`event_id` 有效期 | 文档明确 |

### 6.3 响应

```json
{ "id": "a1b2c3d4-...", "timestamp": "2026-07-21T10:00:00+08:00",
  "ext_info": { "ref_idx": "REFIDX_..." }, "remain_msg_len": 1234 }
```

- `id`：**首条返回的就是后续要用的 `stream_msg_id`**。—— 文档明确
- `remain_msg_len` integer：剩余可发送字符数。—— 文档明确

### 6.4 时序语义（终态标记）

- 首片：`index=0`、`input_state=1`、**不带** `stream_msg_id` → 响应里拿 `id` 当 `stream_msg_id`。
- 续片：`index=1,2,...`、`input_state=1`、带 `stream_msg_id`。
- 终片：`input_state=10`、`index` 继续递增（示例中为 2）、带 `stream_msg_id`。

—— 文档明确（示例三段完整对应）

`input_state=10` 就是**终止标记**（文档原文「10=生成结束」）。没有单独的 "end" 布尔字段。—— 文档明确

### 6.5 适用场景

- **仅单聊（C2C）**。群聊页明确写「注意: **群消息不支持流式参数**」。—— 文档明确
- `content_type` 支持 `text` 与 `markdown`。—— 文档明确

### 6.6 错误码

`40007 已下发内容前缀不可修改`（`replace` 模式下改了已发前缀）、`50001 服务内部错误`、`50002 频率限制`。—— 文档明确

**注意**：`40007` 意味着 `replace` 模式必须维护「已下发全文」，每次都以上一次的完整文本为前缀。用 `append` 模式则只需发增量，实现更简单但客户端拼接语义不同。**未知**：两种模式在客户端的最终渲染差异文档未描述。→ 见「待确认」

---

## 7. 富媒体：上传、file_type、ttl、引用方式

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html

### 7.1 两个上传端点（互不通用）

| 场景 | 端点 |
|---|---|
| 单聊 | `POST /v2/users/{user_openid}/files` |
| 群聊 | `POST /v2/groups/{group_openid}/files` |

—— 文档明确。频控 **50 QPS**。—— 文档明确

**关键约束**：「单聊和群聊的文件上传接口相互独立，上传的文件**不能跨场景使用**」。→ 同一个文件要发到群和私聊，必须传两次。—— 文档明确

### 7.2 请求体

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `file_type` | integer | `1`=图片(png/jpg)、`2`=视频(mp4)、`3`=语音(silk)、`4`=文件 | 文档明确 |
| `url` | string | 媒体 URL，**必须以 http 开头**，平台下载转存；分片合并时可为空 | 文档明确 |
| `srv_send_msg` | boolean | `true`=上传后直接发送（**占主动消息频次**）；`false`=只返回 `file_info` | 文档明确 |
| `upload_id` | string | 分片上传任务 ID（走合并路径时 `url` 可为空） | 文档明确 |
| `file_name` | string | 文件名（分片/二进制上传时必填） | 文档明确 |
| `file_data` | string | 二进制数据，**≤ 5MB**，超过需走 URL 或分片 | 文档明确 |

### 7.3 file_type 与大小限制

| file_type | 类型 | 格式 | 软限制 | 硬限制 |
|---|---|---|---|---|
| `1` | 图片 | png / jpg | 20 MB | 200 MB |
| `2` | 视频 | mp4 | 30 MB | 200 MB |
| `3` | 语音 | silk | 20 MB | 200 MB |
| `4` | 文件 | 任意 | 200 MB | 200 MB |

「超过软限制会**降级为文件类型**上传，超过硬限制会报错」。—— 文档明确

> 注意：`rich-media.html` 的「支持的消息类型」段落写图片支持 `jpg/png/gif/webp/bmp`、语音支持 `silk/mp3/wav/ogg`，但 `file_type` 表格写的是 `png/jpg` 与 `silk`。**两者口径不一致**，以 `file_type` 表格为准更安全（否则可能被 `850019 不支持的文件格式` 拒绝）。

### 7.4 响应

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `file_uuid` | string | 文件唯一 ID | 文档明确 |
| `file_info` | string | **不透明串**，直接塞进 `media.file_info`，**不要解析** | 文档明确 |
| `ttl` | integer | `file_info` 有效期（秒）；**`0` 表示可长期使用** | 文档明确 |
| `id` | string | 消息 ID，仅 `srv_send_msg=true` 时返回 | 文档明确 |
| `raw_url` | string | 下载链接（COS 预签名 GET），有效期同 `ttl`；仅分片合并且 `file_type` 为 1/2/3 时返回 | 文档明确 |

示例：`{"file_uuid":"uuid_a1b2","file_info":"AE86C5D3F0E14B238C656C0F6DD1D0479C","ttl":300}` —— 文档明确（示例 ttl=300s）

### 7.5 分片上传（大文件推荐）

四步（文档明确）：

1. `upload_prepare`：传文件信息 + 校验值 → 拿 `upload_id`、`block_size`、各分片预签名 URL。
2. 按 `block_size` 切分，逐片 `HTTP PUT` 到预签名 URL。
3. 每片 PUT 成功后调 `upload_part_finish` 通知服务端。
4. 全部完成后带 `upload_id` 调 `/files` 完成合并 → 返回 `file_info`。

补充：
- 分片大小默认 **5MB**；并发数、重试策略由服务端在 `upload_config` 下发。—— 文档明确
- `md5_10m`（文件前 10002432 字节 ≈ 9.54 MB 的 MD5）可用于秒传判断。—— 文档明确
- 上传接口超时建议 ≥ 5 秒。—— 文档明确
- **未知**：`upload_prepare` / `upload_part_finish` 的字段 schema 在 sitemap 中只有 `v2_users_user_id_upload_prepare.post.html` 一个页面，群聊对应的预上传端点路径未在文档中列出。→ 见「待确认」

### 7.6 发送时如何引用

```json
POST /v2/users/{user_openid}/messages
{
  "msg_type": 7,
  "media": { "file_info": "{上一步返回的 file_info}" },
  "msg_id": "...",
  "msg_seq": 1
}
```

—— 文档明确

要点：
- 必须 `msg_type=7`，`media.file_info` 放不透明串。
- `file_info` 过期后**必须重新上传**（按 `ttl` 缓存）。
- `srv_send_msg=true` 可省掉一次发消息调用，但**算作主动消息**（占配额）。—— 文档明确

---

## 8. 限流与错误码

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
- https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
- 各 `autogen/api/*` 页的「错误码」小节

### 8.1 接口级 QPS

| 接口 | 限制 | 标注 |
|---|---|---|
| `POST /v2/users/{openid}/messages` | 100 QPS（含主动+被动） | 文档明确 |
| `POST /v2/groups/{group_openid}/messages` | 100 QPS | 文档明确 |
| `POST /v2/users/{openid}/stream_messages` | 50 QPS | 文档明确 |
| `POST /v2/{users\|groups}/{...}/files` | 50 QPS | 文档明确 |

### 8.2 业务级配额（主动消息）

见 §5.6 两张表。核心数字：C2C 单关系 20/qpm、1000 条/用户/天；群 单关系 20/qpm、1000 条/群/天；Bot 维度 C2C 10/qps（未认证 5/qps+30/qpm）、群 60/qpm（未认证 30/qpm）。

### 8.3 HTTP 状态码

| 值 | 含义 | 标注 |
|---|---|---|
| 200 | 成功 | 文档明确 |
| 201 / 202 | 异步操作成功，**但会返回 error body**，需特殊处理 | 文档明确 |
| 204 | 成功无包体（删除类） | 文档明确 |
| 401 | 认证失败 | 文档明确 |
| 404 | 未找到 API | 文档明确 |
| 405 | Method 不允许 | 文档明确 |
| 429 | 频率限制 | 文档明确 |
| 500 / 504 | 处理失败 | 文档明确 |

错误体统一形状：

```json
{ "err_code": 40034005, "message": "回复消息msg_id已过期", "trace_id": "4a8a..." }
```

**判定规则**：文档明确要求「不要依据 `message` 判断是否失败，`message` 可能随时调整，建议根据 `err_code` 判断」。另：`/gateway` 实测错误体同时含 `code` 与 `err_code`（`{"code":11201,"err_code":40012001}`），**两套编号并存**，解析时要都兜住。

### 8.4 常用错误码速查

**鉴权 / 凭证**

| code | 含义 | 处置 |
|---|---|---|
| `100007` | appid invalid（含机器人封禁/删除） | 检查 AppID 与机器人状态 |
| `100016` | invalid appid or secret | 检查 clientSecret |
| `100001` | Too many requests | 退避重试 |
| `10004` | 机器人不存在 | 检查 AppID |
| `11201` / `40012001` | 鉴权失败（实测 `/gateway` 无 token） | 重新取 token |
| `11243` | 校验 token 未通过 | token 错误 |
| `11265` | 机器人已被封禁 | 停止 |

**被动回复**

| code | 含义 |
|---|---|
| `40034005` | 回复消息 msg_id 已过期 |
| `304103` | 消息 ID 已过期，不能回复 |
| `40034128` | 被动回复时间或次数超限 |
| `40034024` | 请求参数 msg_id 无效或越权 |
| `40034025` | 请求参数 event_id 无效 |
| `40034026` | 请求参数 event_id 已过期 |
| `40034027` | 该事件不支持回复消息 |
| `304027` | MSG_EXPIRE 回复的消息过期 |

**去重 / 内容**

| code | 含义 |
|---|---|
| `40054005` | 消息被去重（`msg_seq` 重复） |
| `40034006` | 消息内容违规（审核不通过） |
| `1100101` | 安全打击：内容涉及敏感 |
| `1100100` | 安全打击：消息被限频 |
| `40054007` | 消息长度超限 |
| `40054018` | 消息过长或异常 |
| `40054010` | 不允许发送 URL |
| `22006` | 消息类型与内容不匹配（`msg_type` 与 `content` 不对应） |
| `340069` | 消息类型无效 |

**主动消息 / 关系**

| code | 含义 |
|---|---|
| `40034100` | 主动消息发送超过频控限制 |
| `40034105` | 主动消息发送失败，无权限 |
| `40054004` | 无好友关系（C2C） |
| `40054013` | 用户拒收消息 |
| `40034101` | 机器人非群成员 |
| `40054003` | 机器人不是群成员 |
| `40054002` | 机器人被禁言 |
| `40034122` | 召回消息已达区间上限 |
| `40034123` | 不支持召回消息 |

**富媒体**

| code | 含义 |
|---|---|
| `40034004` | 富媒体信息转存失败（可重试） |
| `304080` | 文件信息无效 |
| `850019` | 不支持的文件格式 |
| `850026` | 下载原始文件失败 |
| `850031` | 上传文件超过大小限制 |
| `40093002` | 超过今天发送文件容量上限 |
| `850018` | 群/机器人被禁言 |

**Markdown**

| code | 含义 |
|---|---|
| `40034008` | markdown 参数有空值 |
| `40034009` | markdown 参数有换行符 |
| `40034010` | 模板参数中不能含 markdown 语法 |
| `40034011` | 无效的 markdown 内容 |
| `40034124` | markdown 消息参数错误 |
| `40034127` / `304036` | 无 markdown 模板权限 |

**网关（WebSocket close code）**

见 §3.6 完整表。最常用：`4006`/`4007` → identify；`4009` → resume；`4013`/`4014` → intents 问题；`4914`/`4915` → 不可连。

—— 以上全部「文档明确」

### 8.5 trace

- 响应头 `X-Tps-trace-ID`，或 body 里的 `trace_id`。—— 文档明确
- 排障时把 `trace_id` 打进日志，提工单要用。—— 文档明确

---

## 9. 事件载荷：GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html

### 9.1 外层信封

```json
{ "id": "event_id", "op": 0, "d": {}, "s": 42, "t": "GATEWAY_EVENT_NAME" }
```

- `id`：**事件 ID**（注意：与 `d.id` 不是同一个东西，`event_id` 回复取的是这一层的 `id`）。—— 文档明确
- `op`：opcode。—— 文档明确
- `s`：序列号，心跳和 resume 都用它。—— 文档明确
- `t`：事件类型，仅 `op=0` 时有意义。—— 文档明确
- `d`：事件内容。—— 文档明确

### 9.2 GROUP_AT_MESSAGE_CREATE

Intent：`GROUP_AND_C2C_EVENT (1<<25)` —— 文档明确

`d` 字段：

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `id` | string | **消息 ID，用于被动回复（作 `msg_id`）和撤回** | 文档明确 |
| `author` | object | 发送者，**`member_openid` 有值** | 文档明确 |
| `content` | string | 消息文本，**「已去除@机器人的前缀」** | 文档明确 |
| `group_openid` | string | 群 OpenID（发消息路径参数） | 文档明确 |
| `timestamp` | string | RFC3339 | 文档明确 |
| `message_type` | integer | 0=普通文本，3=结构化卡片，101=并行消息，102=聊天记录，103=引用消息 | 文档明确 |
| `message_scene` | object | `{source, ext[]}`，`ext` 里是 `msg_idx=` / `ref_msg_idx=` / `auth_token=` 形式的 kv 字符串 | 文档明确 |
| `attachments` | array | 附件（图片/语音/视频/文件） | 文档明确 |
| `mentions` | array | 消息中 @ 的用户列表（**不含 @ 机器人自身**） | 文档明确 |
| `ark_data` | object | 卡片消息数据（`message_type=3`） | 文档明确 |
| `msg_elements` | array | 消息元素列表（递归结构） | 文档明确 |

`author`（User 对象）：

| 字段 | 说明 |
|---|---|
| `id` | 用户唯一标识（OpenID 格式） |
| `username` | 昵称 |
| `bot` | 是否机器人 |
| `union_openid` | 跨应用统一 OpenID（可能为空） |
| `union_user_account` | 跨应用统一账号（可能为空） |
| `user_openid` | 单聊场景用（群事件里通常无值） |
| `member_openid` | **群成员 OpenID（群聊场景用，群事件里有值）** |
| `member_role` | `member` / `admin` / `owner` |

—— 文档明确

**关于 `content` 是否剥离 @**：文档原文明确写「`content` 字段已自动去除@机器人的前缀」。—— 文档明确

但注意：文档示例里 `content` 仍带首尾空格（`" /今日天气 "`、`" 看看这张风景照 "`）。所以**剥离后应 `trim()`**，否则指令匹配会失败。纯 @ 无正文时 `content` 可能是 `" "`（示例 3）。—— 文档明确（示例形态）

真实示例（文档原文，去掉注释）：

```json
{
  "id": "ROBOT1.0_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "author": {
    "id": "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
    "member_openid": "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
    "member_role": "member",
    "username": "小明",
    "bot": false
  },
  "content": " /今日天气 ",
  "group_openid": "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5",
  "message_type": 0,
  "timestamp": "2026-07-21T10:00:00+08:00",
  "message_scene": {
    "source": "default",
    "ext": [
      "msg_idx=REFIDX_xxxxxxxxxxxxxxx==",
      "auth_token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    ]
  }
}
```

带附件的示例：

```json
{
  "id": "ROBOT1.0_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
  "author": {
    "id": "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
    "member_openid": "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
    "member_role": "member",
    "username": "小红",
    "bot": false
  },
  "content": " 看看这张风景照 ",
  "group_openid": "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5",
  "message_type": 0,
  "timestamp": "2026-07-21T10:05:00+08:00",
  "attachments": [
    {
      "content_type": "image/jpeg",
      "filename": "photo.jpg",
      "url": "https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=xxx&rkey=xxx&spec=0",
      "width": 1920,
      "height": 1080,
      "size": 256000
    }
  ],
  "message_scene": {
    "source": "default",
    "ext": [
      "msg_idx=REFIDX_yyyyyyyyyyyyyyy==",
      "auth_token=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
    ]
  }
}
```

`attachments[]` 字段：`url`、`filename`、`width`（仅图片）、`height`（仅图片）、`size`（字节）、`content_type`（`voice` / `image/jpeg` / `image/png` / `image/gif` / `video/mp4` / `file`）、`voice_wav_url`（语音转 WAV 后的 URL）、`asr_refer_text`（语音 ASR 参考结果）。—— 文档明确

### 9.3 C2C_MESSAGE_CREATE

Intent：`GROUP_AND_C2C_EVENT (1<<25)` —— 文档明确

`d` 字段：

| 字段 | 类型 | 说明 | 标注 |
|---|---|---|---|
| `id` | string | 消息 ID，用于被动回复和撤回 | 文档明确 |
| `author` | object | 发送者，**`user_openid` 有值** | 文档明确 |
| `content` | string | 消息文本（**无 @ 概念，不做剥离**） | 文档明确 |
| `timestamp` | string | RFC3339 | 文档明确 |
| `message_type` | integer | 同上 0/3/101/102/103 | 文档明确 |
| `message_scene` | object | 同上 | 文档明确 |
| `attachments` | array | 同上 | 文档明确 |
| `ark_data` | object | 同上 | 文档明确 |
| `msg_elements` | array | 同上 | 文档明确 |

**注意**：C2C 事件的 `d` **没有** `group_openid`；发消息时用 `author.user_openid` 作为路径参数 `{user_openid}`。—— 文档明确（字段表 + 发送接口路径参数名对应）

真实示例：

```json
{
  "id": "ROBOT1.0_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "author": {
    "id": "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
    "user_openid": "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
    "union_openid": "",
    "username": "",
    "bot": false
  },
  "content": "你好，今天有什么推荐的活动吗？",
  "message_type": 0,
  "message_scene": {
    "source": "default",
    "ext": ["msg_idx=REFIDX_xxxxxxxxxxxxxxx=="]
  },
  "timestamp": "2026-07-21T10:00:00+08:00"
}
```

引用消息（`message_type=103`）示例：

```json
{
  "id": "ROBOT1.0_zzzz...",
  "author": {
    "id": "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
    "user_openid": "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
    "union_openid": "",
    "username": "",
    "bot": false
  },
  "content": "这个建议很有帮助，谢谢你！",
  "message_type": 103,
  "msg_elements": [
    {
      "msg_idx": "REFIDX_aaaaaaaaaaaaaaa==",
      "message_type": 103,
      "content": "每天坚持阅读半小时，一个月后你会发现自己的变化"
    }
  ],
  "message_scene": {
    "source": "default",
    "ext": ["ref_msg_idx=REFIDX_aaaaaaaaaaaaaaa==", "msg_idx=REFIDX_zzzzzzzzzzzzzzz=="]
  },
  "timestamp": "2026-07-21T10:02:00+08:00"
}
```

### 9.4 幂等 / 去重

- 「为确保消息可达，相同 `msg_id` 可能重复推送，开发者需结合 `msg_seq` 做去重」。—— 文档明确（两个事件页都有这句）
- C2C 页另有一句「需结合 `message_scene.ext` 中的 `msg_idx` 做去重」。—— 文档明确

**实现含义**：`msg_id`（= `d.id`）在推送层是**可能重复**的。收到同一 `d.id` 两次应只处理一次（`Map<id, ts>` + TTL 清理）。

### 9.5 群聊还有 GROUP_MESSAGE_CREATE

overview 页的场景表里，群聊接收事件列出了 `GROUP_AT_MESSAGE_CREATE` **和** `GROUP_MESSAGE_CREATE`（后者是「接收群内全部消息」能力，需要群主在入群时授权）。—— 文档明确（表里列了）

**未知**：`GROUP_MESSAGE_CREATE` 的 `d` 结构与 `GROUP_AT_MESSAGE_CREATE` 是否完全一致、是否需要额外 intent 位、是否属于 `1<<25` —— 文档未给独立页面。→ 见「待确认」

---

## 10. 内容长度限制与 Markdown 子集

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
- https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html

### 10.1 单条消息最大长度

**未知**。

可以确认的：
- 存在明确的上限：错误码 `40054007 消息长度超限`、`40054018 消息过长或异常`。—— 文档明确
- 流式接口返回 `remain_msg_len`（剩余字符数），说明长度按**字符**计而非字节。—— 文档明确

但**具体阈值（多少字符 / 多少字节）在所有官方页面中均未给出**。我检索了 `message/overview.html`、`message/type/overview.html`、`changelog.html`、`bot_FAQ`、两个发送接口页、`error/error.html`，均无数字。

**不要写死某个数字**（社区流传的 4000/5000 之类无官方出处）。正确做法：由 `40054007` / `40054018` 驱动自适应分段，并把阈值做成配置。—— 由文档推断

### 10.2 官方对长内容的指引

**未知**。文档没有「长文本如何拆分」的章节。唯一的官方相关能力是：
- 流式消息（§6）——但**仅单聊**支持。—— 文档明确
- 群聊只能整条发送，超长即报错。

### 10.3 Markdown 支持情况

**权限**：「2026/04/23 能力更新说明：单聊场景、群聊场景自定义 Markdown 消息能力**已开放到所有机器人均可使用，无需单独申请 Markdown 模版**，频道场景目前需要内邀开通」。—— 文档明确

**支持的语法子集**（逐项来自官方示例）：

| 语法 | 支持 | 备注 |
|---|---|---|
| 标题 `#` `##` | ✅ | 只示例了一号/二号 |
| 加粗 `**x**` | ✅ | |
| 下划线加粗 `__x__` | ✅ | |
| 斜体 `_x_` / `*x*` | ✅ | |
| 加粗斜体 `***x***` | ✅ | |
| 删除线 `~~x~~` | ✅ | |
| 链接 `[text](url)` | ✅ | |
| 自动链接 `<https://...>` | ✅ | |
| 图片 `![alt #w #h](url)` | ✅ | **URL 必须公网可访问**，平台会下载转存 |
| 有序列表 `1.` | ✅ | |
| 无序列表 `-` | ✅ | |
| 列表嵌套 | ✅ | 二级需空 4 空格；普通文本前需空行隔开 |
| 块引用 `>` | ✅ | |
| 水平分割线 `***` | ✅ | |
| 代码块 ``` ``` | ❌ | **官方示例中未出现，不支持** |
| 表格 | ❌ | **未出现，不支持** |

—— 文档明确（支持项）/ 由文档推断（不支持项：官方「支持格式」章节是穷举式的，未列即不支持）

**Markdown 里的图片两种来源**：
1. 公网 URL（平台转存）。—— 文档明确
2. 先上传素材拿 `qqbot-media://` 引用，再在 Markdown 里直接用。—— 文档明确（详见 `material-management.html`）

**注意**：`markdown.content` 与 `content` 互斥——「传了 markdown 后此字段必须为空」。—— 文档明确

**注意**：错误码 `40034009 markdown参数有换行符` 说明模板参数场景下不能带换行；但自定义 `content` 的官方示例里是带 `\n` 的（`"# 标题 \n## 简介很开心 \n内容..."`）。两者是不同场景（模板 params vs content），不要混淆。—— 由文档推断

### 10.4 纯文本里的内联语法

| 语法 | 场景 | 标注 |
|---|---|---|
| `<qqbot-at-user id="" />` | 群聊、文字子频道（@某人） | 文档明确 |
| `<@userid>` | 同上，**即将弃用** | 文档明确 |
| `<qqbot-at-everyone />` | **仅文字子频道** | 文档明确 |
| `@everyone` | 同上，即将弃用 | 文档明确 |
| `<qqbot-cmd-enter text="xxx" />` | **仅 markdown**，群聊/子频道不支持 | 文档明确 |
| `<qqbot-cmd-input text="xxx" show="xxx" reference="false" />` | 仅 markdown，参数最大 100 字符、需 urlencode | 文档明确 |
| `<#channel_id>` | 仅频道 | 文档明确 |
| `<emoji:id>` | 仅频道，仅 `type=1` 系统表情 | 文档明确 |

**群聊里要 @ 人**：用 `<qqbot-at-user id="{member_openid}" />`，`id` 填 `member_openid`。—— 由文档推断（文档只说 `id=""`，结合 openid 体系推断应填 member_openid）

---

## 11. 运营前置条件

来源：
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/bot_FAQ/
- https://bot.q.qq.com/wiki/develop/api-v2/
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html

### 11.1 回调地址是否必需

**不需要（WebSocket 模式）**。

- 平台支持两种接入：Webhook（HTTP 回调）与 WebSocket。—— 文档明确
- 「开发者可通过管理端设定回调地址」——是**可选**的接入方式，不是前置条件。—— 文档明确
- Webhook 模式才有 `op=12`（HTTP Callback ACK）和 `op=13`（回调地址验证），WebSocket 模式用不到。—— 文档明确
- 若走 Webhook：端口只允许 `80 / 443 / 8080 / 8443`；需要 ed25519 签名校验（用 `botSecret` 派生 seed）。—— 文档明确

### 11.2 IP 白名单

**未知**。全部相关页面（`api-call-guide`、`api-use`、`event-emit`、`bot_FAQ`、`access-token`）均未提及 IP allowlist / 白名单。

管理端可能提供该配置项（`q.qq.com` 后台），但**文档正文没有记载**。→ 见「待确认」

已知的相关安全约束只有：
- 「为了安全考虑，请勿在应用前端使用访问凭证。请在应用服务端发起 API 访问请求」。—— 文档明确
- Webhook 模式建议排查防火墙误拦截。—— 文档明确

### 11.3 沙箱 vs 生产

- **新版管理端已不需要沙箱环境**：FAQ 原文「使用管理员账号进入新版机器人管理端后，**管理员账号可直接测试使用，无需沙箱环境**（旧版管理端已不支持添加沙箱群\频道配置）」。—— 文档明确
- 但沙箱概念仍在错误码中残留：`4914 机器人已下架，只允许连接沙箱环境，请断开连接，检验当前连接环境`。—— 文档明确
- **未知**：`4914` 场景下「沙箱环境」的具体接入方式（是否不同域名/不同网关地址）文档未说明。→ 见「待确认」

### 11.4 群聊 / C2C 是否需要申请或审批

分几层，别混：

| 事项 | 是否需要申请 | 标注 |
|---|---|---|
| 收到群 @ 消息 / C2C 消息（`intents = 1<<25`） | **需要**——`1<<25` 属于「特殊事件」，文档说特殊事件「都需要经过申请才能够使用」，无权限时传了会直接断开连接 | 文档明确 |
| 群聊 / 单聊自定义 Markdown | **不需要**（2026/04/23 起全量开放） | 文档明确 |
| 消息按钮（keyboard） | **不需要**（FAQ：已开放到所有机器人） | 文档明确 |
| 频道 Markdown | 需要内邀 | 文档明确 |
| `union_openid` 打通 | 需要邮件申请（`qq_bot_api@tencent.com`） | 文档明确 |
| 公开使用（让任意用户加机器人） | 企业主体已开放；**个人主体暂不支持公开使用** | 文档明确 |

**个人主体的实操路径**（FAQ 原文）：
- 加群：机器人创建者可直接把机器人加到自己**是群主/管理员**的群（需最新版手机 QQ）。
- 单聊：在新版管理端「开发设置」里添加**开发体验用户**号码。

—— 文档明确

### 11.5 机器人在线要求

- 频道场景原文：「发送消息接口要求机器人接口需要**连接到 WebSocket 上保持在线状态**」。—— 文档明确
- 全局错误码 `304018 SESSION_NOT_EXIST 机器人没连上 gateway`。—— 文档明确
- **由文档推断**：群聊 / C2C 发消息同样要求网关在线（否则 `304018` 会出现在任何场景）。这对桥接实现是硬约束——**HTTP 发消息前必须确保 WS 已 READY**。

### 11.6 主体与配额的关系

认证等级直接决定主动消息频控（§5.6）：企业/个人认证 > 未认证。C2C 未认证只有 `5/qps + 30/qpm`。—— 文档明确

---

## 待确认

以下条目在官方文档中**找不到明确答案**，实现时不要写死，做成可配置或运行时探测：

1. **`zlib-stream` / 压缩支持**——全部文档零提及；连接 URL 无任何 query 参数；无相关 opcode/错误码。是否支持、帧分隔符是否为 `0x00 0x00 0xff 0xff`、是否需要在 URL 上加 `compress=` 参数：**全部未知**。
2. **单条文本消息的最大长度**——只有 `40054007` / `40054018` 两个错误码，无任何数字阈值（字符数或字节数均无）。
3. **`msg_seq` 的递增步长**——文档只说「递增」「不填默认 1」「相同 `msg_id + msg_seq` 会失败」，未规定必须 +1，也未说明计数作用域。
4. **Resume 的会话保留时长**——只说「短时间内重连会补发」，没有具体秒数。
5. **IP 白名单**——文档正文完全未提及。
6. **「私域 / 公域」的正式定义**——只在 intents 注释里出现「仅私域」，没有定义与判定方式。
7. **群 / C2C 事件在多分片下如何分配**——分片哈希规则只给了 `(guild_id >> 22) % num_shards`，而群 / C2C 事件没有 `guild_id`。
8. **`op=9 Invalid Session` 的 `d` 载荷形状**——是否像 Discord 那样带一个「可否 resume」的布尔值，文档未给。
9. **服务端主动发心跳（op=1）的触发条件**，以及「多久没收到 op=11 判定断线」的超时建议——文档未定义。
10. **`properties` 是否必填**——文档说「可以留空」，但示例总是带上；不确定留空是否会被 `4002 无效 payload` 拒绝。
11. **`code` 与 `err_code` 两套编号的映射关系**——`/gateway` 实测返回 `{"code":11201,"err_code":40012001}`，文档只分别列出两套表，没给映射规则。
12. **C2C 被动回复窗口到底是 60 分钟还是 5 分钟**——页面顶部写 60 分钟/4 次，`msg_id` 字段描述写「5 分钟内有效」，同一页自相矛盾。
13. **长内容的官方拆分指引**——无。
14. **`GROUP_MESSAGE_CREATE`（群全量消息）的完整定义**——只在场景表里出现名字，没有事件页、没有 intent 位说明、没有 `d` 结构。
15. **`upload_prepare` / `upload_part_finish` 的群聊对应端点路径**——sitemap 里只见到 `v2_users_user_id_upload_prepare.post.html`，群聊侧的预上传路径未列出。
16. **`stream` 的 `append` vs `replace` 在客户端的渲染差异**——文档只描述了服务端合并逻辑，没说用户看到什么。
17. **`ark` 字段**——发送接口请求体未列该字段，但错误码里有 `304004 无权限使用该ARK模板`；是否仍可通过某字段发 ARK 消息未知。
18. **纯文本消息中 URL 的拦截规则**——`40054010 不允许发送URL` 存在，但什么条件下允许/拒绝未知。
19. **沙箱环境的具体接入方式**（`4914` 提到的场景）——是否不同网关地址未知。
20. **`shards` 建议值是否必须遵守**——文档说「建议」，但 `4011` 又要求合理分片，边界不清。

---

## 对实现的直接影响

1. **`intents` 只需 `1<<25`（33554432）**，不要加 `1<<30`——后者是频道 @ 消息，与群 / C2C 无关；而 `GUILD_MESSAGES` 是 `1<<9`（512）不是 `1<<0`，照抄 Discord 必挂。同时 `1<<25` 属「特殊事件」，无权限时连接会被**直接关闭**（4013/4014），所以 `intents` 必须可配置，不能硬编码。
2. **token 只有一种，前缀固定 `QQBot `**：`getAppAccessToken` 拿到的 `access_token` 同时用于 HTTP 的 `Authorization: QQBot {token}` 和 identify 的 `d.token`。缓存到 TTL 剩 60 秒内再刷（有效期内重复请求返回同值，是幂等的），不要每条消息都换。
3. **被动回复必须带 `msg_id` + 递增的 `msg_seq`**，且要在窗口内：群聊 5 分钟 / 5 次，单聊按 60 分钟 / 4 次设计但按 5 分钟兜底。同一个 `msg_id` 复用同一个 `msg_seq` 会被 `40054005` 去重拒绝——所以桥接层要维护 `Map<msg_id, nextSeq>`，每次回复自增。
4. **`d.id` 是回复用的 `msg_id`，外层 `id` 是 `event_id`，两者不能混**。而 `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` 只能用 `msg_id` 回复（`event_id` 只支持 INTERACTION_CREATE / GROUP_ADD_ROBOT / C2C_MSG_RECEIVE / FRIEND_ADD 等），用错会拿到 `40034027 该事件不支持回复消息`。
5. **群 @ 消息的 `content` 已剥离 @ 前缀，但仍带首尾空格**（示例 `" /今日天气 "`），必须 `trim()` 后再匹配指令；纯 @ 无正文时可能是 `" "`，要按空消息处理。C2C 的 `content` 不做剥离。
6. **网关按纯文本 JSON 处理**：文档无任何压缩协商，连接 URL 是裸 `wss://api.bot.qq.com/websocket/`。实现上 `binaryType='arraybuffer'` + 字符串帧直接 `JSON.parse`，同时保留一个二进制兜底分支（先试 UTF-8，失败再 `createInflate` 流式解压——**不能逐帧 `inflateSync`**）。
7. **断线重连要分两路**：`4009`（连接过期）/ 网络断开且持有 `session_id`+`seq` → 发 `op=6 resume`；`4006` / `4007` / `4900~4913` / 任何 `session_id` 丢失 → 必须重新 `op=2 identify`。`4914`（已下架）/ `4915`（已封禁）/ `4001`/`4002`/`4010`~`4014` 不要重连风暴。`session_start_limit` 每日 1000 次、每 5s `max_concurrency` 次，重连要有指数退避。
8. **发消息前必须确保网关在线**（`304018 SESSION_NOT_EXIST`），且单聊与群聊的文件上传**互不通用**——同一张图发群和发私聊要各传一次，`file_info` 按 `ttl` 缓存（示例 300s，`0` 表示长期）。
