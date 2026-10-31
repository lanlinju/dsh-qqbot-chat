# 本地装配

把本插件挂进 `~/.dsh/profiles/web`，用真实凭据跑通一次往返。

> README 的「安装」一节讲三条安装路径（设置里装 / 命令行 / tarball）。本文是**装完之后**的细节：目录联接怎么建、bundle 怎么登记、appId 放哪、出问题看哪里。

## 1. 本地开发：建两个目录联接

改代码要即时生效就用联接，不要复制（复制了改代码不生效）。`node_modules/` 已 gitignore。

下面这段可以整段粘进 PowerShell，带 `Test-Path` 守卫，重复执行不报「已存在」：

```powershell
$repo = 'D:\Dev\ts\dsh-plugins\dsh-qqbot-chat'
$home_host = "$HOME\.dsh\profiles\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path "$repo\node_modules", "$HOME\.dsh\profiles\node_modules\@lanlinju" | Out-Null
if (-not (Test-Path "$repo\node_modules\@deepseek-ai")) { New-Item -ItemType Junction -Path "$repo\node_modules\@deepseek-ai" -Target $home_host | Out-Null }
if (-not (Test-Path "$HOME\.dsh\profiles\node_modules\@lanlinju\dsh-qqbot-chat")) { New-Item -ItemType Junction -Path "$HOME\.dsh\profiles\node_modules\@lanlinju\dsh-qqbot-chat" -Target $repo | Out-Null }
```

Git Bash 等价写法：

```bash
repo=/d/Dev/ts/dsh-plugins/dsh-qqbot-chat
mkdir -p "$repo/node_modules" "$HOME/.dsh/profiles/node_modules/@lanlinju"
ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai" "$repo/node_modules/@deepseek-ai"
ln -s "$repo" "$HOME/.dsh/profiles/node_modules/@lanlinju/dsh-qqbot-chat"
```

**为什么是两个联接**，它们各解决一个不同的问题：

| 联接 | 解决什么 | 不做的后果 |
|---|---|---|
| 仓库 `node_modules/@deepseek-ai` → profile 的 | 插件运行时 `import '@deepseek-ai/dsh-llm'` 等宿主包 | `ERR_MODULE_NOT_FOUND`，启动日志里是 `failed to import` |
| profile `@lanlinju/dsh-qqbot-chat` → 仓库 | dsh 的 loader 用 `import(包名)` 加载插件，它从 profile 的 `node_modules` 往上找 | `cannot resolve profile bundle` |

关键细节：Node **会把符号链接解析成真实路径**，所以从 `D:\Dev\...\src` 往上找是找不到 profile 里那些包的——这就是第一个联接存在的原因，不是多余操作。

> 终端里如果看到 `@//deepseek-ai/`、`0.0.0.0/` 这种，是反斜杠被渲染坏了，不是真实路径。

## 2. 登记 bundle

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm（`dsh plugin --help` 原文：*forwarding the remaining arguments to pnpm*），所以它只写 `dependencies`，**不会**动 `dsh.profile.bundles`。实测只加依赖时插件完全不加载、日志里连 `[qqbot] apply called` 都没有。

编辑 `~/.dsh/profiles/web/package.json`，把包名加进 `bundles`：

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

不想手改就用这条命令（`node` 得在 PATH 里）：

```bash
node -e "const f=process.env.HOME+'/.dsh/profiles/web/package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f,'utf8')),b=p.dsh.profile.bundles;b.includes('@lanlinju/dsh-qqbot-chat')||b.push('@lanlinju/dsh-qqbot-chat');fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
```

确认插件行真的进了合成配置——**这一步别跳过**，它比启动日志更早暴露问题：

```bash
dsh --profile web --dump-config | grep -A2 qqbot-chat
```

有 `- id: qqbot-chat` 就对了；什么都没有说明 `bundles` 没生效。

> 通过「设置 → 插件 → 安装」的界面路径可能自动登记 bundle，但只在 CLI 路径上验过，所以按上面写。

## 3. 给 appId

bundle 层不带 appId（那是每台机器自己的东西）。二选一：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 这一层在 bundle 之后应用，会覆盖
- id: qqbot-chat
  config:
    appId: '1903967151'
```

或者启动前 `QQ_BOT_APP_ID=1903967151 dsh web`。两个都没给的话，插件会在挂载时报错退出，提示 `qqbot-chat needs the bot AppID`。

> 不用 bundle、直接手写 `insert` 也可以（完整示例见仓库根 `cordis.patch.example.yml`）。那种写法下 `name` 必须是**包名**，不能写绝对路径——`D:/...` 不以 `.` 开头，会被当成裸 specifier 交给 `import()`，在 Windows 上直接解析失败。

## 4. 凭据

`appSecret` 不进仓库、不进 patch，只进 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  QQ_BOT_APP_SECRET: <app secret>
```

配置里的 `appSecretRef` 装的是**引用名**（默认就是 `QQ_BOT_APP_SECRET`），不是密钥本身。临时验证也可以直接 `QQ_BOT_APP_SECRET=xxx dsh web`——环境变量优先级高于文件。

## 5. 起服务

```bash
dsh web --no-open
```

`dsh` 不在 PATH 时报 `CommandNotFoundException`，它只是一个 JS 入口：

```powershell
node "$HOME\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" web --no-open
```

日志里应出现 `gateway READY`。想看插件自己的连接轨迹，加 `DSH_QQBOT_DEBUG=1`，它会往 stderr 打 `[qqbot]` 行（`apply called` → `gateway url ...` → `socket open` → `<- op=10` → `<- op=0 t=READY`）。

## 6. 验证

1. 私聊机器人发一句「你好」→ 几秒内收到回答，`~/.dsh/qqbot-workspace` 被创建，Web UI 侧边栏出现 `QQ-<尾号>` 会话。
2. 群里发一句（`groupReply` 默认 `all`，不用 @）→ 同样回话，会话键是 `group:<group_openid>`，进入 agent 的消息带 `[成员 xxxxxx]` 前缀。
3. 发 `/new` → 回「已开启新会话。」，上下文清空。
4. `Ctrl+C` 退出 → 不留悬挂 socket。

## 回滚

- 摘挂载：把包名从 `dsh.profile.bundles` 删掉（或删掉手写的 `insert` 那条）。
- 清依赖：`dsh plugin --profile web remove @lanlinju/dsh-qqbot-chat`。
- 清会话索引：删 `$DSH_HOME/qqbot-chat/sessions.json`（下次消息会重新建会话）。
