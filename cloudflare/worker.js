// Cloudflare Workers 入口。
// 部署：cd cloudflare && wrangler deploy
// 密钥：cd cloudflare && wrangler secret put DEEPSEEK_API_KEY
import handler from '../handler.js'

export default {
  fetch: (request, env) => handler(request, env)
}
