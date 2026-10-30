/**
 * Host half of `dsh-auto-title` (自动会话标题 / Auto Session Title).
 *
 * 两件事 / Two responsibilities:
 *  1. 占据会话标题 provider 槽位，模式为 `all-prompts`：每轮用户消息之后，用会话
 *     上下文重新提炼标题，并保证它是一行、且不超过 12 个汉字宽。
 *     Owns the session-title provider seat with an `all-prompts` provider, so the
 *     title is re-derived after every user turn and always fits one short line.
 *  2. 提供客户端「刷新标题」菜单项调用的 HTTP 路由，用于强制重新提炼。
 *     Serves the HTTP route the client menu row calls to force a refresh.
 *
 * 只通过注入的服务工作（`sessionTitle` / `llm` / `sessions` / 可选 `webServer`），
 * 不 import 任何 Harness 包，因此可以跨 Harness 版本使用。
 * Everything goes through injected services only; no Harness package is imported,
 * so the bundle keeps working across Harness upgrades.
 */

const ROUTE = '/auto-title/refresh'
const PROVIDER_ID = 'auto-title'

/**
 * 可调参数 / Tunables.
 * 想改标题长度就改 `maxTitleUnits`：一个汉字（全角字符）记 1，其他字符记 0.5。
 * Change `maxTitleUnits` to widen or tighten the title: a wide glyph scores 1,
 * every other character 0.5.
 */
export const DEFAULTS = Object.freeze({
  /** 标题上限，单位是「汉字宽」/ title budget in CJK columns. */
  maxTitleUnits: 12,
  /** 单次模型调用的输出上限 / output cap per model call. */
  maxOutputTokens: 512,
  /** 每条用户消息送入模型前的截断长度 / per-message clipping. */
  maxMessageChars: 600,
  /** 送入模型的消息总字符预算 / total input budget. */
  maxInputChars: 4000,
  /** 除首条消息外，最多再带多少条最近的用户消息 / recent tail size. */
  tailMessages: 8,
  /** 同一会话两次自动提炼的最小间隔，防止连发消息时刷屏 / throttle. */
  minAutoIntervalMs: 4000,
})

export const name = PROVIDER_ID
export const inject = ['sessionTitle', 'llm', 'sessions']

const SYSTEM = [
  '你是会话标题生成器。',
  '输入是一个 JSON 数组，每项是这段对话里的一条用户消息（seq 为序号，text 为内容）。',
  '输出：这段对话的标题，一行纯文本。',
  '规则：',
  '1. 只输出标题本身：不要引号、不要书名号、不要 Markdown、不要「标题：」之类前缀、不要句末标点、不要解释。',
  `2. 篇幅上限为 ${DEFAULTS.maxTitleUnits} 个汉字宽：一个汉字计 1，其他字符（拉丁字母、空格、符号）计 0.5。宁可更短。`,
  '3. 使用对话本身的语言。',
  '4. 概括整体主题；如果对话中途换了主题，以当前正在做的事情为主。',
  '5. 不要回答问题，不要复述原句，不要出现「用户」「对话」「会话」等元词。',
  '6. 内容太少时给一个最贴近的短语（例如：问候、环境检查）。',
].join('\n')

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

/** 按标题预算截断，不会把代理对（emoji）切成两半 / clamp without splitting surrogates. */
function clampTitle(text) {
  let units = 0
  let out = ''
  for (const char of text) {
    const unit = isWide(char) ? 1 : 0.5
    if (units + unit > DEFAULTS.maxTitleUnits) break
    units += unit
    out += char
  }
  return out
}

const EDGE_PUNCTUATION = /^[\s"'`“”‘’「」『』《》〈〉(){}[\]#>*_~·•\-–—:：,，、;；.。!！?？…]+|[\s"'`“”‘’「」『』《》〈〉(){}[\]#>*_~·•\-–—:：,，、;；.。!！?？…]+$/gu

/**
 * 把模型的原始输出收拾成一行干净的短标题。
 * Reduce a raw model answer to one short, plain title line.
 * @param raw 模型输出 / the model output.
 * @returns 标题，或空字符串（没有可用内容时）/ the title, or '' when nothing is usable.
 */
function finalizeTitle(raw) {
  const source = String(raw ?? '')
  const lines = source.split(/\r?\n/u)
  let line = ''
  for (const candidate of lines) {
    const trimmed = candidate.trim()
    if (trimmed !== '') {
      line = trimmed
      break
    }
  }
  if (line === '') return ''
  line = line.replace(/^#{1,6}\s*/u, '')
  line = line.replace(/^[*_~`]+|[*_~`]+$/gu, '').trim()
  const wrapped = /^(?:["'`“”‘’「」『』《》])(.*?)(?:["'`“”‘’「」『』《》])$/u.exec(line)
  if (wrapped !== null && wrapped[1].trim() !== '') line = wrapped[1].trim()
  line = line.replace(/^(?:标题|会话标题|session\s*title|title)\s*[:：\-–—]\s*/iu, '')
  line = line.replace(/[*_`~#]/gu, '')
  line = line.replace(/\s+/gu, ' ').trim()
  return clampTitle(line).replace(EDGE_PUNCTUATION, '').trim()
}

/**
 * 挑出值得总结的消息：首条 + 最近若干条，并受总长度预算约束。
 * `messageSeqs` 必须是有序、去重、且属于请求消息的子集 —— 这里靠构造保证。
 * Pick the messages worth summarizing: the opening message plus the most recent
 * ones, bounded in total size. `messageSeqs` must stay a unique, ordered subset
 * of the request's messages, which this guarantees by construction.
 */
function pickMessages(messages) {
  const items = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = String(message?.text ?? '').replace(/\s+/gu, ' ').trim()
    if (text === '') continue
    items.push({
      seq: message.seq,
      text: text.length > DEFAULTS.maxMessageChars ? `${text.slice(0, DEFAULTS.maxMessageChars)}…` : text,
    })
  }
  if (items.length === 0) return { items: [], seqs: [] }
  const first = items[0]
  const tail = items.slice(-DEFAULTS.tailMessages)
  const chosen = tail.includes(first) ? [...tail] : [first, ...tail]
  const sizeOf = () => chosen.reduce((sum, item) => sum + item.text.length, 0)
  while (chosen.length > 2 && sizeOf() > DEFAULTS.maxInputChars) chosen.splice(1, 1)
  return { items: chosen, seqs: chosen.map((item) => item.seq) }
}

/** 不调模型时的确定性兜底标题 / deterministic stand-in when no model call is made. */
function cheapTitle(picked) {
  const last = picked.items[picked.items.length - 1]
  const text = String(last?.text ?? '').replace(/\s+/gu, ' ').trim()
  return clampTitle(text).replace(EDGE_PUNCTUATION, '').trim() || '未命名会话'
}

/** 保留已经接受的标题，而不是把它降级成兜底标题 / keep the accepted title. */
function holdTitle(request, picked) {
  const current = request?.currentTitle
  const title = typeof current?.title === 'string' ? current.title.trim() : ''
  if (title === '') return { title: cheapTitle(picked), messageSeqs: picked.seqs }
  const seqs = Array.isArray(current.messageSeqs) ? current.messageSeqs : []
  return { title, messageSeqs: seqs.length > 0 ? [...seqs] : picked.seqs }
}

function routeOf(request) {
  const fromRequest = request?.route
  if (fromRequest !== undefined && fromRequest !== null) return fromRequest
  const session = request?.session
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    return header?.config
  } catch {
    return undefined
  }
}

async function generateTitle(ctx, state, request) {
  const session = request?.session
  const sessionId = String(session?.id ?? '')
  const forced = sessionId !== '' && state.forced.delete(sessionId)
  const picked = pickMessages(request?.messages)
  if (picked.seqs.length === 0) throw new Error('auto-title: no user text to summarize yet')

  // 子会话（子智能体）用确定性标题：它们的标题几乎没人看，每轮调模型纯属浪费。
  // Child sessions (subagents) get a cheap deterministic title: their titles are
  // rarely read, and a model call per subagent turn would be pure cost.
  const parentSession = session?.header?.parentSession
  if (parentSession !== undefined && !forced) return holdTitle(request, picked)

  const now = Date.now()
  if (!forced && now - (state.lastRunAt.get(sessionId) ?? 0) < DEFAULTS.minAutoIntervalMs) {
    return holdTitle(request, picked)
  }

  const route = routeOf(request)
  if (route === undefined || route === null || route.provider === '' || route.model === '') {
    return holdTitle(request, picked)
  }

  state.lastRunAt.set(sessionId, now)
  return callModel(ctx, { sessionId: session.id, picked, route, signal: request.signal })
}

/**
 * 调模型把挑好的消息提炼成一行标题。
 * Turn the picked messages into one title through the model.
 */
async function callModel(ctx, { sessionId, picked, route, signal }) {
  const payload = JSON.stringify(picked.items)
  let output = ''
  let finish
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `用户消息：\n${payload}\n\n请输出这段对话的标题。` }],
      },
    ],
    system: SYSTEM,
    maxTokens: DEFAULTS.maxOutputTokens,
    sessionId,
    purpose: 'session-title',
    signal,
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') output += chunk.text ?? ''
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  const title = finalizeTitle(output)
  if (title === '') {
    const reason = typeof finish?.kind === 'string' ? ` (${finish.kind})` : ''
    throw new Error(`auto-title: the model produced no usable title${reason}`)
  }
  return {
    title,
    messageSeqs: picked.seqs,
    model: { provider: route.provider, model: route.model },
  }
}

/**
 * 从会话日志的原始事件里取出用户消息文本。
 * User text carried by raw session-log events.
 */
function userMessagesFromEvents(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const data = event.data
    const source = data?.source
    if (source !== undefined && source !== null && source.kind !== 'user') continue
    const blocks = Array.isArray(data?.content) ? data.content : []
    const text = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join(' ')
    if (text.trim() === '') continue
    out.push({ seq: event.seq, text })
  }
  return out
}

/** 日志里最后一次请求记录的模型路由 / The model route of the last recorded request. */
function routeFromEvents(events) {
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (
      typeof config?.provider === 'string' &&
      typeof config?.model === 'string' &&
      config.provider !== '' &&
      config.model !== ''
    ) {
      return config
    }
  }
  return undefined
}

/**
 * 给「没打开」的会话提炼标题：直接读写它的持久化日志，不把它载入内存。
 * Retitle a session that is not live by reading and appending its durable log,
 * without restoring it into the live store.
 */
async function refreshColdSession(ctx, state, sessionId) {
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') {
    throw new Error('no sessionPersistence service in this composition')
  }
  const reader = await persistence.open(sessionId, 'read')
  let events = []
  try {
    const result = await reader.read()
    events = Array.isArray(result?.events) ? result.events : []
  } finally {
    await reader.close()
  }
  const picked = pickMessages(userMessagesFromEvents(events))
  if (picked.seqs.length === 0) throw new Error('this session has no user message to summarize yet')
  const route = routeFromEvents(events)
  if (route === undefined) {
    throw new Error('this session has no recorded model route; open it once and retry')
  }
  const computed = await callModel(ctx, { sessionId, picked, route, signal: undefined })
  const writer = await persistence.open(sessionId, 'write')
  try {
    const result = await writer.read()
    const tail = Array.isArray(result?.events) ? result.events : []
    const last = tail.length > 0 ? tail[tail.length - 1] : undefined
    const seq = (typeof last?.seq === 'number' ? last.seq : -1) + 1
    await writer.append([
      {
        type: 'session/title',
        seq,
        time: Date.now(),
        data: {
          title: computed.title,
          messageSeqs: computed.messageSeqs,
          source: { kind: 'provider', provider: PROVIDER_ID, model: computed.model },
        },
      },
    ])
    await writer.flush()
  } finally {
    await writer.close()
  }
  state.lastRunAt.set(sessionId, Date.now())
  return computed
}

function sendJson(response, status, payload) {
  if (response === null || typeof response !== 'object' || response.writableEnded === true) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * 路由处理：强制为一个会话重新提炼标题。
 * Route handler: force a fresh title for one session.
 * @param ctx 插件上下文 / plugin context.
 * @param state 插件内部状态 / plugin-local state.
 * @param request `{ url }` / `{ url }`.
 * @param response Node 响应对象 / Node response.
 */
async function handleRefresh(ctx, state, request, response) {
  let sessionId = ''
  try {
    const url = new URL(String(request?.url ?? '/'), 'http://auto-title.invalid')
    sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
    if (sessionId === '') {
      sendJson(response, 400, { ok: false, error: 'missing sessionId' })
      return
    }
    const session = typeof ctx.sessions.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    if (session === undefined || session === null) {
      // 没打开的会话不在内存里：直接读写它的日志，效果和打开后再刷新一样。
      // A session nobody opened is not in memory: retitle it straight from its log.
      const cold = await refreshColdSession(ctx, state, sessionId)
      sendJson(response, 200, { ok: true, title: cold.title, source: 'provider' })
      return
    }
    state.forced.add(sessionId)
    try {
      const snapshot = await ctx.sessionTitle.refresh(session)
      if (snapshot === undefined || snapshot === null || typeof snapshot.title !== 'string') {
        sendJson(response, 200, { ok: false, error: 'no title provider produced a title' })
        return
      }
      sendJson(response, 200, {
        ok: true,
        title: snapshot.title,
        source: snapshot.source?.kind ?? 'unknown',
      })
    } finally {
      state.forced.delete(sessionId)
    }
  } catch (error) {
    if (sessionId !== '') state.forced.delete(sessionId)
    const message = String(error?.message ?? error)
    // 会话日志不存在 → 404；其余（模型失败、写占用等）→ 500 并把原因带给按钮。
    const missing = /notfound|not found|does not exist/i.test(message) || /notfound/i.test(String(error?.name ?? ''))
    sendJson(response, missing ? 404 : 500, { ok: false, error: message })
  }
}

/**
 * 把路由挂到当前 unit 上；服务还不在就返回 false。
 * Mount the route on `unit`; returns false while the service is not there yet.
 * @param unit 拥有 `webServer` 服务的上下文 / context owning `webServer`.
 * @param state 插件内部状态 / plugin-local state.
 */
function mountRefreshRoute(unit, state) {
  const webServer = typeof unit.get === 'function' ? unit.get('webServer') : undefined
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    return false
  }
  unit.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (request, response) => {
          void handleRefresh(unit, state, request, response)
        },
      }),
    'auto-title: refresh route',
  )
  return true
}

function registerRefreshRoute(ctx, state) {
  if (mountRefreshRoute(ctx, state)) return
  // 冷启动时 webServer 可能还没就绪：等它注入完成再挂，插件其余部分照常工作。
  // At cold start webServer may not exist yet: wait for injection, keep the rest live.
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('auto-title: no webServer service and no inject(); the refresh row stays inert')
    return
  }
  try {
    ctx.inject(['webServer'], (unit) => {
      if (!mountRefreshRoute(unit, state)) {
        unit.logger?.warn?.('auto-title: webServer has no register(); the refresh row stays inert')
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(
      `auto-title: could not wait for webServer: ${String(error?.message ?? error)}`,
    )
  }
}

export function apply(ctx) {
  const state = { forced: new Set(), lastRunAt: new Map() }

  ctx.effect(() => {
    let dispose
    try {
      dispose = ctx.sessionTitle.register({
        id: PROVIDER_ID,
        automatic: 'all-prompts',
        generate: (request) => generateTitle(ctx, state, request),
      })
    } catch (error) {
      ctx.logger?.warn?.(
        `auto-title: could not take the session title provider seat: ${String(error?.message ?? error)}`,
      )
      return () => {}
    }
    return () => {
      try {
        void dispose?.()
      } catch (error) {
        ctx.logger?.warn?.(`auto-title: provider dispose failed: ${String(error?.message ?? error)}`)
      }
    }
  }, 'auto-title: session title provider')

  registerRefreshRoute(ctx, state)
}
