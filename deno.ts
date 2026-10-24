// Deno Deploy 入口（新建项目时把入口文件指到 deno.ts 即可）。
// 环境变量在 Deno Deploy 项目设置里配 DEEPSEEK_API_KEY。
import handler from './handler.js'

Deno.serve((request) => handler(request, Deno.env.toObject()))
