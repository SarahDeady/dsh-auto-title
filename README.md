# dsh-auto-title · 自动会话标题

> 给会话起一个像样的名字，而不是「帮我搞一个自动更新会话标题的插件」。
> A DeepSeek Harness plugin that keeps every session titled with one short, meaningful line.

**中文名：自动会话标题　English: Auto Session Title**

![icon](icon.svg)

## 它做什么

- **自动提炼**：每轮对话之后，用会话上下文重新总结标题，始终是一行、不超过 12 个汉字宽（一个汉字计 1，其他字符计 0.5）。
- **你说了算**：只要你在侧栏手动改过一次标题，它就**永久停手**，不再自动覆盖——这是 Harness 标题服务自带的「用户改名即锁定」语义，插件只是顺着它工作。
- **随时重来**：会话「⋯」菜单里多了一行 **刷新标题**，点一下立刻重新提炼；正在提炼时该行显示「正在提炼标题…」并禁用，失败会红字提示并给出原因，再点一次即可重试。
- **省钱**：同一会话 4 秒内不重复调模型；子会话（子智能体）不调模型，直接用确定性的短标题。

## 怎么装

前提：已经装好 DeepSeek Harness（桌面端），并且你把仓库拿到了本地：

```bash
git clone https://github.com/SarahDeady/dsh-auto-title.git
```

### 方式一：让 DSH 自己装（推荐）

在 Harness 里对 Agent 说一句：

> 用 plugin_manager install_bundle 安装 `C:\path\to\dsh-auto-title` 这个目录

安装成功会返回 `"application": "applied"`。**重启 Harness** 让新的 Host 模块生效。

### 方式二：手动挂载（高级）

在你的 profile 目录（Windows 一般是 `C:\Users\<你>\.dsh\profiles\desktop`）里：

1. 让它指向仓库目录——在 profile 的 `package.json` 依赖里加一条
   `"dsh-auto-title": "link:C:/path/to/dsh-auto-title"`，然后 `pnpm install`；
2. 在同一个 `package.json` 的 `dsh.profile.bundles` 数组末尾加上 `"dsh-auto-title"`；
3. 重启 Harness。

两种方式装完后，都去会话「⋯」菜单确认出现了 **刷新标题**。

## 它替换了什么（重要）

Harness 的 `sessionTitle` 服务**只接受一个**标题 provider。本插件注册一个 `automatic: 'all-prompts'`（每轮都更新）的 provider，因此会在 `cordis.patch.yml` 里**停用内置的 `session-title-llm`**（first-prompt 生成器）。停用它不会影响其它功能，只是把「起标题」这件事交给本插件。

想换回去：删掉 profile 里本插件的 bundle 行，并在 profile 的 `cordis.patch.yml` 里把 `session-title-llm` 的 `disabled` 去掉。

## 菜单项怎么用

右键（或点「⋯」）任意会话 → **刷新标题**：

| 状态 | 显示 |
| --- | --- |
| 空闲 | 刷新标题 |
| 提炼中 | 正在提炼标题…（禁用） |
| 成功 | 菜单关闭，侧栏标题与页头标题自动更新 |
| 失败 | 刷新失败，点击重试（悬停可看具体原因） |

## 工作原理

```text
用户发消息
   │
   ├─ 内置 sessionTitle 服务收集消息 ──► 本插件 generate()
   │                                        │
   │                                        ├─ ctx.llm.stream({ purpose: 'session-title' })
   │                                        └─ 清洗成一行 ≤ 12 列 → { title, messageSeqs, model }
   │
   └─ 服务 append `session/title` 事件 ──► 内置 `title` session projection ──► UI 自动更新
```

- **注册座位**：`ctx.sessionTitle.register({ id: 'auto-title', automatic: 'all-prompts', generate })`。
- **只走注入的服务**：Host 半不 import 任何 Harness 包，因此跨 Harness 版本升级不易碎。
- **手动改名即暂停**：侧栏改名走的是服务自己的 `rename()`，它追加 `source: user` 的标题事件并锁定；此后服务不再为用户消息调度自动生成——插件什么都不用做。
- **刷新按钮**：客户端 `POST /auto-title/refresh?sessionId=…` → Host 调 `ctx.sessionTitle.refresh(session)`，绕过上面的锁定/节流强制重算；新的标题照样通过 projection 回到 UI。

## 调参

Host 半顶部导出了 `DEFAULTS`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `maxTitleUnits` | `12` | 标题上限，单位「汉字宽」（汉字 1、其他 0.5） |
| `maxOutputTokens` | `512` | 单次模型调用的输出上限 |
| `maxMessageChars` | `600` | 每条用户消息送进模型前的截断长度 |
| `maxInputChars` | `4000` | 送入消息的总字符预算 |
| `tailMessages` | `8` | 除首条外，额外携带的最近消息条数 |
| `minAutoIntervalMs` | `4000` | 同一会话两次自动提炼的最小间隔 |

想改成 8 个字？把 `maxTitleUnits` 改成 `8` 即可（改完重启 Harness）。

## 要求与限制

- DeepSeek Harness **桌面端**，Web profile 运行（菜单动作需要 Host 的 `webServer` 服务；没有它时插件仍会装好，只是菜单行点不动，日志里会有一条 warn）。
- 只对 **live**（当前 Harness 进程里打开着）的会话生效。
- 子会话（子智能体）不调模型，用确定性短标题。
- 模型没有可用路由（会话还没发过请求，或 provider 未配置）时，退回确定性标题，不会报错。
- 标题按 **UTF-8 列宽** 记账，不是字符数：12 个汉字或 24 个拉丁字母。

## 开发

```bash
npm test    # 15 个用例：provider 注册、模型调用参数、长度与清洗、节流、子会话、刷新路由 400/404/200、清理
npm run check  # 语法检查
```

测试不需要 Harness：`test/smoke.mjs` 用一个假 ctx 直接跑 Host 半。

## 许可

MIT © 2026 SarahDeady

---

## English

**Auto Session Title** keeps every DeepSeek Harness session named with one short line distilled from its context — at most 12 columns wide (a CJK glyph counts 1, anything else 0.5).

- Re-derives the title after every user turn via the shipped `sessionTitle` service (`automatic: 'all-prompts'`).
- Stops for good as soon as **you** rename a session: Harness pins a user-authored title, so the service no longer schedules automatic generation.
- Adds a **Refresh title** row to a session's "⋯" menu that forces a fresh distillation through `ctx.sessionTitle.refresh()`, with busy / failed states.
- Skips model calls for child (subagent) sessions, and throttles automatic runs to one per 4 seconds per session.

Install: clone the repo and ask DSH to `plugin_manager install_bundle <repo path>`, then restart Harness. The plugin's `cordis.patch.yml` disables the built-in `session-title-llm` provider, because the `sessionTitle` service seats only one provider.

Everything in the Host half goes through injected services (`sessionTitle`, `llm`, `sessions`, optional `webServer`); no Harness package is imported, so upgrades are unlikely to break it.

MIT © 2026 SarahDeady
