# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。
All notable changes to this project are documented here.

## [Unreleased]

## [1.0.1] - 2026-10-29

### 修复 / Fixed

- **冷启动后「刷新标题」失效**：插件加载时 `webServer` 服务还没就绪，路由因此从未注册，菜单行点了永远是「刷新失败」。现在等 `webServer` 注入完成后再挂路由，两条路径都能生效。
- 刷新端点改用 `GET`：Harness Web 的鉴权层会把未认证的 `POST` 直接回 405（连路由都进不去），`GET` 可以正常到达插件路由。

## [1.0.0] - 2026-10-29

### 新增 / Added

- 会话标题 provider（`automatic: 'all-prompts'`）：每轮用户消息后，用会话上下文重新提炼标题。
- 标题长度约束：一行、不超过 12 个「汉字宽」（汉字计 1，其他字符计 0.5），并清洗 Markdown、引号、句末标点与「标题：」之类前缀。
- 侧栏会话「⋯」菜单新增 **刷新标题** 一行：点一下强制重新提炼，带提炼中 / 失败（含原因）两种状态。
- `POST /auto-title/refresh?sessionId=…` 路由：返回 `{ ok, title, source }`，缺少 sessionId 返回 400，会话不在本进程返回 404。
- 省钱措施：同一会话 4 秒节流；子会话不调模型；模型无路由时退回确定性标题。
- 卸载时释放 provider 座位与路由（全部走 `ctx.effect`）。
- `test/smoke.mjs`：15 个不依赖 Harness 的用例，`npm test` 直接跑。

### 说明 / Notes

- 由于 `sessionTitle` 服务只接受一个 provider，`cordis.patch.yml` 会停用内置的 `session-title-llm`。
- 用户手动重命名后自动更新停止，这是 Harness 自带的「改名即锁定」语义；需要时用菜单里的 **刷新标题** 强制重算。
