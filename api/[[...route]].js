// Vercel Functions 入口：整仓库导入 Vercel 即可，api/ 目录会被自动识别。
// 环境变量在 Vercel 项目设置里配 DEEPSEEK_API_KEY（可选 PERSONA / ALLOW_ORIGIN）。
import handler from '../handler.js'

export default (request) => handler(request, process.env)

export const config = { runtime: 'edge' }
