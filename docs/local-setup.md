# 本地装配

把本插件挂进 `~/.dsh/profiles/web`，用真实凭据跑通一次往返。

> 安装的推荐路径（`dsh plugin add` / 设置里装 / tarball 兜底）写在 README 的「安装」一节。本文是本机开发时的细节：目录联接怎么建、配置怎么叠、出问题看哪里。

## 1. 让宿主包可解析

插件运行时 `import` 宿主包（`@deepseek-ai/dsh-llm` 等），但它们只装在 dsh 的 profile 里。仓库通过一个**目录联接**把它们借过来（`node_modules/` 已 gitignore，不入库）：

```powershell
New-Item -ItemType Junction `
  -Path  D:\Dev\ts\dsh-plugins\dsh-qqbot-chat\node_modules\@deepseek-ai `
  -Target C:\Users\<you>\.dsh\profiles\node_modules\@deepseek-ai
```

同时把包本身接进 profile 的解析路径（插件由 `cordis-plugin-loader` `import()`，它从 `profiles/node_modules` 往上找）：

```powershell
New-Item -ItemType Junction `
  -Path  C:\Users\<you>\.dsh\profiles\node_modules\@lanlinju\dsh-qqbot-chat `
  -Target D:\Dev\ts\dsh-plugins\dsh-qqbot-chat
```

## 2. 凭据

`appSecret` 不进仓库、不进 patch，只进 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
refs:
  QQ_BOT_APP_SECRET: <app secret>
```

配置里的 `appSecretRef: QQ_BOT_APP_SECRET` 装的是**引用名**，不是密钥本身。临时验证也可以直接 `QQ_BOT_APP_SECRET=xxx dsh web`——环境变量优先级高于文件。

## 3. 挂载

`~/.dsh/profiles/web/cordis.patch.yml` 追加一条 insert（完整示例见仓库根的 `cordis.patch.example.yml`）：

```yaml
- insert:
    - id: qqbot-chat
      name: '@lanlinju/dsh-qqbot-chat'
      config:
        appId: '1903967151'
        appSecretRef: QQ_BOT_APP_SECRET
        intents: 33554432
        workspacePath: '~/.dsh/qqbot-workspace'
        maxConcurrent: 1
```

`name` 必须是**包名**，不能写绝对路径——`D:/...` 不以 `.` 开头，会被当成裸 specifier 交给 `import()`，在 Windows 上直接解析失败。

## 4. 起服务

```bash
dsh web --no-open
```

日志里应出现 `gateway READY`。想看插件自己的连接轨迹，加 `DSH_QQBOT_DEBUG=1`，它会往 stderr 打 `[qqbot]` 行（`apply called` → `gateway url ...` → `socket open` → `<- op=10` → `<- op=0 t=READY`）。

## 5. 验证

1. 私聊机器人发一句「你好」→ 应在几秒内收到回答，`~/.dsh/qqbot-workspace` 被创建，Web UI 侧边栏出现 `QQ-<尾号>` 会话。
2. 群里 @ 机器人一次 → 同样回话，会话键是 `group:<group_openid>`，消息前带 `[成员 xxxxxx]`。
3. 发 `/new` → 回「已开启新会话。」，上下文清空。
4. `Ctrl+C` 退出 → 不留悬挂 socket。

## 回滚

删掉 `cordis.patch.yml` 里那条 insert 即摘挂载；`dsh plugin --profile web remove @lanlinju/dsh-qqbot-chat` 清依赖。
