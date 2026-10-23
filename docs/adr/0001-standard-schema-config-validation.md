# Config 用手写 Standard Schema 校验，不依赖 schemastery

宿主生态里的插件一律 `import z from "@deepseek-ai/schemastery"`，但本仓有一条硬约束：运行时零第三方依赖。读了 `cordis/lib/index.js:956` 才发现这条约束不必让步——loader 是 `if (!runtime.Config) return config;`，校验只调 `Config["~standard"].validate(config)`，它认的是 Standard Schema 接口，不是 schemastery 本身。所以 `src/config.js` 手写一个 `{ "~standard": { version: 1, vendor, validate } }` 对象（约 40 行），既守住零依赖，又保住 loader 级校验和「错误定位到 patch 那一行」的能力。代价是以后加字段得同时改表、改校验器、改文档三处，而 schemastery 只需要改一处。

## Consequences

- 别把 `@deepseek-ai/schemastery` 加回来当"就一个依赖"。加回来就破约束，而且换不来任何手写做不到的东西。
- `validate` 必须是同步的：`resolveConfig` 里写着 `if ("then" in result) throw new TypeError("Async config validation is not supported")`。
- 返回的 `issues` 要带字段路径，否则用户看到的只是一句"配置非法"。
