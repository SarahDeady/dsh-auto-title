/**
 * `dsh-auto-title` 的冒烟测试 / smoke test for dsh-auto-title.
 *
 * 不依赖 DeepSeek Harness：用一个假的 ctx 直接跑 Host 半，覆盖
 * provider 注册、模型调用参数、标题清洗与长度、消息子集、节流、
 * 无路由、子会话、刷新路由（400/404/200）、强制绕过与节流、空输出报错、卸载清理。
 * No Harness dependency: a fake ctx drives the Host half and covers provider
 * registration, model call shape, title cleanup/length, the message subset rule,
 * throttling, the no-route path, child sessions, the refresh route (400/404/200),
 * force-bypass, the empty-output error, and teardown.
 *
 * 运行 / run: `npm test`（Node.js >= 22）。
 */
import assert from 'node:assert/strict'
import { apply, DEFAULTS, inject, name } from '../index.js'

/* ------------------------------------------------------------------ helpers */

function isWide(char) {
  const code = char.codePointAt(0)
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

/** 与插件相同的「汉字宽」记账 / the same column accounting the plugin uses. */
function units(text) {
  let total = 0
  for (const char of text) total += isWide(char) ? 1 : 0.5
  return total
}

function makeSession(id, extra = {}) {
  return { id, header: { ...extra }, requestHeader: () => undefined }
}

/**
 * 假 ctx：只实现插件真正用到的那几样。`sessionTitle.refresh` 的行为照抄真服务：
 * 有 provider 时就用最新消息再生成一次标题（这正是「强制刷新绕过节流」的来源）。
 * A fake ctx with exactly the pieces the plugin touches. `sessionTitle.refresh`
 * mirrors the real service: with a provider seated it re-generates from the
 * latest messages, which is what lets a forced refresh skip the throttle.
 */
function makeCtx() {
  const effects = []
  const routes = new Map()
  const seat = { current: null }
  const llmCalls = []
  const sessions = new Map()
  const refreshes = []
  let nextStream = null

  const ctx = {
    logger: { warn: () => {} },
    get: (key) => (key === 'webServer' ? webServer : undefined),
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    sessions: { get: (id) => sessions.get(id) },
    sessionTitle: {
      register(candidate) {
        if (seat.current !== null) throw new Error('already registered')
        seat.current = candidate
        return async () => {
          seat.current = null
        }
      },
      async refresh(session) {
        refreshes.push(session.id)
        if (seat.current === null) return undefined
        const result = await seat.current.generate({
          session,
          messages: [{ seq: 1, text: '强制刷新时的最新一条用户消息' }],
          route: { provider: 'p', model: 'm' },
          currentTitle: { title: '旧标题', messageSeqs: [1] },
          signal: new AbortController().signal,
        })
        return { title: result.title, messageSeqs: result.messageSeqs, source: { kind: 'provider', provider: 'auto-title' } }
      },
    },
    llm: {
      stream(options) {
        llmCalls.push(options)
        const chunks = nextStream ?? []
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }

  const webServer = {
    getOrigin: () => 'http://127.0.0.1:0',
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }

  return {
    ctx,
    effects,
    routes,
    seat,
    llmCalls,
    sessions,
    refreshes,
    /** 下一次 `llm.stream` 吐出的块 / chunks the next stream yields. */
    setStream(chunks) {
      nextStream = chunks
    },
  }
}

function textDelta(text) {
  return { type: 'text-delta', text }
}

function finish(kind = 'stop') {
  return { type: 'finish', reason: { kind } }
}

const results = []

/** 跑一个用例；同步抛错和 reject 都算失败 / run a case; sync throws and rejections fail it. */
async function check(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
    console.log(`  ✓ ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

/* -------------------------------------------------------------------- cases */

console.log('dsh-auto-title smoke test\n')

const app = makeCtx()
apply(app.ctx)

/** 调用刷新路由，等响应真正写完 / drive the refresh route until the response is done. */
async function postRefresh(url) {
  const handler = app.routes.get('/auto-title/refresh')
  assert.equal(typeof handler, 'function', 'refresh route is not registered')
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const response = {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
      this.writableEnded = true
      resolveDone()
    },
  }
  handler({ url }, response)
  await done
  return { status: response.status, payload: JSON.parse(response.body) }
}

await check('exports the bundle identity', () => {
  assert.equal(name, 'auto-title')
  assert.deepEqual([...inject], ['sessionTitle', 'llm', 'sessions'])
  assert.equal(DEFAULTS.maxTitleUnits, 12)
})

await check('registers the provider and the refresh route as effects', () => {
  assert.deepEqual(
    app.effects.map((effect) => effect.label),
    ['auto-title: session title provider', 'auto-title: refresh route'],
  )
  assert.equal(app.seat.current?.id, 'auto-title')
  assert.equal(app.seat.current?.automatic, 'all-prompts')
  assert.equal(app.routes.has('/auto-title/refresh'), true)
})

await check('calls the model with purpose=session-title on the session route', async () => {
  app.setStream([textDelta('会话标题插件'), finish()])
  const result = await app.seat.current.generate({
    session: makeSession('s-model'),
    messages: [
      { seq: 1, text: '帮我做一个自动更新会话标题的插件' },
      { seq: 2, text: '要在会话菜单里加一个刷新按钮' },
    ],
    route: { provider: 'deepseek', model: 'deepseek-chat' },
    signal: new AbortController().signal,
  })
  assert.equal(result.title, '会话标题插件')
  assert.deepEqual(result.model, { provider: 'deepseek', model: 'deepseek-chat' })
  const call = app.llmCalls.at(-1)
  assert.equal(call.purpose, 'session-title')
  assert.equal(call.provider, 'deepseek')
  assert.equal(call.model, 'deepseek-chat')
  assert.equal(call.maxTokens, DEFAULTS.maxOutputTokens)
  assert.equal(call.sessionId, 's-model')
  assert.equal(call.messages[0].role, 'user')
  assert.match(call.messages[0].content[0].text, /seq/u)
})

await check('messageSeqs is a unique, ordered subset of the request messages', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    seq: index + 1,
    text: `第 ${index + 1} 条用户消息`,
  }))
  app.setStream([textDelta('有序子集'), finish()])
  const result = await app.seat.current.generate({
    session: makeSession('s-subset'),
    messages,
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  const allowed = new Set(messages.map((message) => message.seq))
  assert.ok(result.messageSeqs.length > 0)
  assert.equal(new Set(result.messageSeqs).size, result.messageSeqs.length)
  for (const seq of result.messageSeqs) assert.ok(allowed.has(seq))
  assert.deepEqual(result.messageSeqs, [...result.messageSeqs].sort((a, b) => a - b))
})

await check('clamps the title to the 12-column budget and strips decoration', async () => {
  app.setStream([
    textDelta('**把会话标题自动更新成一行**\n'),
    textDelta('第二行不该出现，标点也该去掉。'),
    finish(),
  ])
  const result = await app.seat.current.generate({
    session: makeSession('s-clamp'),
    messages: [{ seq: 1, text: '把标题做短一点' }],
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  assert.ok(units(result.title) <= DEFAULTS.maxTitleUnits, `"${result.title}" 有 ${units(result.title)} 列`)
  assert.ok(result.title.length > 0)
  assert.doesNotMatch(result.title, /[*#`]/u)
  assert.doesNotMatch(result.title, /[。，、；：！？.]$/u)
  assert.ok(!result.title.includes('第二行'))
})

await check('clamps an over-long single line without splitting characters', async () => {
  app.setStream([textDelta('把这个问题彻底讲清楚并且顺手把插件打包好发到网上'), finish()])
  const result = await app.seat.current.generate({
    session: makeSession('s-long'),
    messages: [{ seq: 1, text: '写长一点' }],
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  assert.ok(units(result.title) <= DEFAULTS.maxTitleUnits, `"${result.title}" 有 ${units(result.title)} 列`)
  assert.ok(!result.title.includes('\uFFFD'))
})

await check('holds the current title while throttled', async () => {
  const session = makeSession('s-throttle')
  app.setStream([textDelta('第一次的标题'), finish()])
  const first = await app.seat.current.generate({
    session,
    messages: [{ seq: 1, text: '第一次提问' }],
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  const before = app.llmCalls.length
  const second = await app.seat.current.generate({
    session,
    messages: [
      { seq: 1, text: '第一次提问' },
      { seq: 2, text: '紧接着第二次提问' },
    ],
    currentTitle: { title: first.title, messageSeqs: first.messageSeqs },
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  assert.equal(app.llmCalls.length, before, '节流期间不该再调模型')
  assert.equal(second.title, first.title)
  assert.deepEqual(second.messageSeqs, first.messageSeqs)
})

await check('falls back deterministically when no model route is available', async () => {
  const before = app.llmCalls.length
  const result = await app.seat.current.generate({
    session: makeSession('s-noroute'),
    messages: [
      { seq: 7, text: '   ' },
      { seq: 8, text: '没有模型路由时的兜底标题' },
    ],
    signal: new AbortController().signal,
  })
  assert.equal(app.llmCalls.length, before, '没有路由就不该调模型')
  assert.ok(typeof result.title === 'string' && result.title.length > 0)
  assert.ok(units(result.title) <= DEFAULTS.maxTitleUnits)
  assert.deepEqual(result.messageSeqs, [8])
})

await check('never spends a model call on a child session', async () => {
  const before = app.llmCalls.length
  const result = await app.seat.current.generate({
    session: makeSession('s-child', { parentSession: 's-parent' }),
    messages: [{ seq: 3, text: '子会话不该调模型' }],
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  assert.equal(app.llmCalls.length, before)
  assert.ok(result.title.length > 0)
  assert.deepEqual(result.messageSeqs, [3])
})

await check('rejects an empty model answer so the accepted title survives', async () => {
  app.setStream([finish('max-tokens')])
  await assert.rejects(
    app.seat.current.generate({
      session: makeSession('s-empty'),
      messages: [{ seq: 4, text: '模型什么都没说' }],
      route: { provider: 'p', model: 'm' },
      signal: new AbortController().signal,
    }),
    /no usable title/u,
  )
})

await check('refresh route: 400 without a sessionId', async () => {
  const { status, payload } = await postRefresh('/auto-title/refresh')
  assert.equal(status, 400)
  assert.deepEqual(payload, { ok: false, error: 'missing sessionId' })
})

await check('refresh route: 404 for a session that is not live', async () => {
  const { status, payload } = await postRefresh('/auto-title/refresh?sessionId=nope')
  assert.equal(status, 404)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /not live/u)
})

await check('refresh route: 200 and a fresh title for a live session', async () => {
  app.sessions.set('s-live', makeSession('s-live'))
  app.setStream([textDelta('菜单点下去的刷新标题'), finish()])
  const { status, payload } = await postRefresh('/auto-title/refresh?sessionId=s-live')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.title, '菜单点下去的刷新标题')
  assert.equal(payload.source, 'provider')
  assert.deepEqual(app.refreshes, ['s-live'])
})

await check('a forced refresh bypasses the throttle, once', async () => {
  const session = makeSession('s-forced')
  app.sessions.set('s-forced', session)
  app.setStream([textDelta('普通轮次生成的标题'), finish()])
  await app.seat.current.generate({
    session,
    messages: [{ seq: 1, text: '普通的一轮' }],
    route: { provider: 'p', model: 'm' },
    signal: new AbortController().signal,
  })
  const before = app.llmCalls.length
  app.setStream([textDelta('绕过节流重新提炼'), finish()])
  const { payload } = await postRefresh('/auto-title/refresh?sessionId=s-forced')
  assert.equal(payload.ok, true)
  assert.equal(payload.title, '绕过节流重新提炼', '会话刚落过一次模型，节流期内强制刷新仍须出结果')
  assert.equal(app.llmCalls.length, before + 1)
})

await check('teardown releases the provider seat and the route', () => {
  for (const effect of app.effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  assert.equal(app.seat.current, null)
  assert.equal(app.routes.has('/auto-title/refresh'), false)
})

/* ------------------------------------------------------------------ summary */

const failed = results.filter((result) => result.ok === false)
console.log(`\n${results.length - failed.length}/${results.length} 通过 · ${failed.length} 失败`)
if (failed.length > 0) {
  for (const result of failed) console.error(`\n✗ ${result.label}\n${result.error?.stack ?? result.error}`)
  process.exitCode = 1
}
