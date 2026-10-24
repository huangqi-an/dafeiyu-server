/**
 * dafeiyu-server —— 大肥鱼网页宠物的自建后端，零依赖单文件。
 *
 * 一个 Web 标准 fetch handler，可跑在：Node ≥18、Cloudflare Workers、
 * Vercel Functions（edge/node）、Deno。协议与 dafeiyu 客户端约定一致：
 *
 *   GET  /         → { name, ok, keyConfigured }            探活/自检
 *   GET  /whisper  → { line: string, source }               一句碎碎念
 *   POST /chat     → SSE：data:{"d":增量}|{"e":错误}|[DONE]  流式对话
 *                    请求体 { messages:[{role,content}...] }
 *
 * 环境变量（由各平台入口注入）：
 *   DEEPSEEK_API_KEY  必填才有 AI；缺省时全部降级本地台词，服务照常
 *   PERSONA           可选，人设正文覆盖（默认是通用「网页宠物大肥鱼」）
 *   ALLOW_ORIGIN      可选，CORS 允许来源，默认 *（宠物脚本要跨站调用）
 *
 * 限流：单实例内存计数（whisper 6 次/10 分钟/IP，chat 20 次/10 分钟/IP，
 * 全局 1000 次/天封顶）。Serverless 平台（Workers/Vercel）的实例是弹性的，
 * 内存限流只能挡单实例，跨实例不保证——介意的话在网关层再加，见 README。
 */

const DS_URL = 'https://api.deepseek.com/chat/completions'
// 2026-10 官方 API 只剩 deepseek-flash / deepseek-v4-pro（deepseek-chat 已废弃）；
// flash 是推荐默认且便宜，宠物场景够用
const DS_MODEL = 'deepseek-flash'

const DEFAULT_PERSONA =
  '你是一个网站的网页宠物"大肥鱼"——一条 Q 版蓝发小女仆，长着鲸鱼尾巴，住在网页右下角陪访客。' +
  '说话自然口语、简短可爱、带点俏皮，说人话不啰嗦，不解释自己是 AI，不提模型和程序。' +
  '访客问历史、常识、技术问题时照常简短作答，别推脱。'

const FALLBACK_LINES = [
  '（还没接上大脑，先本地陪聊）',
  '今天也在右下角值班。',
  '咕噜咕噜～',
  '摸鱼要适度哦。',
  '慢慢来，比较快。',
  '要不要休息一下眼睛？',
  '深海信号一般，凑合听。'
]

// ── 工具 ──────────────────────────────────────────────────────

function timeContext(now = new Date()) {
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const h = now.getHours()
  const period = h < 5 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜'
  const weekend = now.getDay() === 0 || now.getDay() === 6
  return `现在是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week} ${period}（${weekend ? '周末' : '工作日'}）。`
}

function systemPrompt(env, kind) {
  const persona = (typeof env.PERSONA === 'string' && env.PERSONA.trim()) || DEFAULT_PERSONA
  const base = `${persona}\n你的名字是"大肥鱼"。\n${timeContext()}`
  if (kind === 'whisper') {
    return `${base}\n现在随口碎碎念一句话：20 字以内，贴合时间背景，不要堆问候语。只输出这句话本身。`
  }
  return `${base}\n正在和网站访客聊天，回复保持简短（一般两三句以内）。`
}

function hasKey(env) {
  const k = env.DEEPSEEK_API_KEY
  return typeof k === 'string' && k !== '' && k !== 'change-me'
}

async function deepseek(env, body, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(DS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: DS_MODEL,
        // flash 默认开启思考模式：碎碎念/闲聊不需要，先思考既拖慢首响应又按输出计费
        thinking: { type: 'disabled' },
        ...body
      }),
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

function localLine() {
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)]
}

// ── 限流（单实例内存态）───────────────────────────────────────

const buckets = new Map()
let daily = { date: '', n: 0 }
const DAILY_CAP = 1000

function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip')
  if (xff) return xff.split(',')[0].trim()
  return 'unknown'
}

function rateAllow(ip, key, limit, windowMs) {
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  if (daily.date !== today) {
    daily = { date: today, n: 0 }
    if (buckets.size > 5000) buckets.clear()
  }
  if (daily.n >= DAILY_CAP) return false
  const k = `${key}:${ip}`
  const b = buckets.get(k)
  if (!b || now > b.reset) {
    buckets.set(k, { n: 1, reset: now + windowMs })
    daily.n++
    return true
  }
  if (b.n >= limit) return false
  b.n++
  daily.n++
  return true
}

// ── 响应构造（统一带 CORS）────────────────────────────────────

function corsHeaders(env) {
  return {
    'access-control-allow-origin': typeof env.ALLOW_ORIGIN === 'string' && env.ALLOW_ORIGIN ? env.ALLOW_ORIGIN : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  }
}

function json(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(env) }
  })
}

// ── 三个端点 ──────────────────────────────────────────────────

async function whisper(env, request) {
  const ip = clientIp(request)
  // 超限也回 200 + 本地台词：不再打 DeepSeek，但宠物照常说得上话
  if (!rateAllow(ip, 'whisper', 6, 10 * 60_000)) return json(env, { line: localLine(), source: 'local' })
  if (!hasKey(env)) return json(env, { line: localLine(), source: 'local' })
  try {
    const res = await deepseek(
      env,
      {
        messages: [
          { role: 'system', content: systemPrompt(env, 'whisper') },
          { role: 'user', content: '碎碎念一句' }
        ],
        max_tokens: 60,
        temperature: 1.3
      },
      10_000
    )
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    const data = await res.json()
    const line = String(data?.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["「『“]+|["」』”]+$/g, '')
      .replace(/\s+/g, ' ')
    if (line) return json(env, { line: line.slice(0, 120), source: 'deepseek' })
    throw new Error('empty')
  } catch {
    return json(env, { line: localLine(), source: 'local' })
  }
}

const MAX_MESSAGES = 10
const MAX_CHARS = 500

async function chat(env, request) {
  const ip = clientIp(request)
  let body
  try {
    body = await request.json()
  } catch {
    return json(env, { message: '请求体不是合法 JSON' }, 400)
  }
  const raw = body?.messages
  if (!Array.isArray(raw) || raw.length === 0) return json(env, { message: 'messages 不能为空' }, 400)
  if (raw.length > MAX_MESSAGES) return json(env, { message: `对话历史最多 ${MAX_MESSAGES} 条` }, 400)
  const messages = []
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return json(env, { message: 'role 只能是 user 或 assistant' }, 400)
    if (typeof m.content !== 'string' || !m.content.trim()) return json(env, { message: 'content 必须是非空字符串' }, 400)
    if (m.content.length > MAX_CHARS) return json(env, { message: `单条消息超过 ${MAX_CHARS} 字` }, 400)
    messages.push({ role: m.role, content: m.content })
  }
  if (!rateAllow(ip, 'chat', 20, 10 * 60_000)) return json(env, { message: '聊得太快啦，歇一会儿再试' }, 429)
  if (!hasKey(env)) {
    return json(env, { message: '站长还没配 DEEPSEEK_API_KEY，宠物暂时只会本地台词' }, 503)
  }

  let upstream
  try {
    upstream = await deepseek(
      env,
      {
        messages: [{ role: 'system', content: systemPrompt(env, 'chat') }, ...messages],
        max_tokens: 800,
        temperature: 0.8,
        stream: true
      },
      60_000
    )
  } catch {
    return json(env, { message: '上游超时了，稍后再试' }, 504)
  }
  if (!upstream.ok || !upstream.body) return json(env, { message: '上游模型没响应，稍后再试' }, 502)

  // 把上游 OpenAI 风格 SSE 改写成 {d}/{e} 协议下发
  const upstreamBody = upstream.body
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      const reader = upstreamBody.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let doneSent = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '[DONE]') continue
              try {
                const evt = JSON.parse(payload)
                const delta = evt?.choices?.[0]?.delta?.content
                if (typeof delta === 'string' && delta) send({ d: delta })
              } catch {
                /* 忽略解析不了的行（keep-alive 注释等） */
              }
            }
          }
        }
        if (!doneSent) {
          doneSent = true
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        }
        controller.close()
      } catch {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ e: '连接中断了' })}\n\n`))
        controller.close()
      }
    },
    cancel() {
      upstreamBody.cancel().catch(() => {})
    }
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      ...corsHeaders(env)
    }
  })
}

// ── 入口 ──────────────────────────────────────────────────────

export default async function handler(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) })

  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/'

  if (path === '/' && request.method === 'GET') {
    return json(env, { name: 'dafeiyu-server', ok: true, keyConfigured: hasKey(env) })
  }
  if (path === '/whisper' && request.method === 'GET') return whisper(env, request)
  if (path === '/chat' && request.method === 'POST') return chat(env, request)

  return json(env, { message: 'not found' }, 404)
}
