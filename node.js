// Node ≥18 运行器：把 fetch handler 适配到 node:http。
// 用法：DEEPSEEK_API_KEY=sk-... PORT=8787 node node.js
import http from 'node:http'
import { Readable } from 'node:stream'
import handler from './handler.js'

const PORT = Number(process.env.PORT || 8787)

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const chunks = []
    for await (const c of req) chunks.push(c)
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    })
    const response = await handler(request, process.env)

    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res)
    } else {
      res.end()
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: String(err?.message || err) }))
  }
})

server.listen(PORT, () => {
  console.log(`dafeiyu-server on http://0.0.0.0:${PORT}  (key ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置，走本地台词'})`)
})
