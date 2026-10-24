# dafeiyu-server

[dafeiyu](https://github.com/huangqi-an/dafeiyu)（大肥鱼网页宠物）的自建后端：**零依赖单文件**，
提供 AI 碎碎念与流式聊天两个端点，密钥留在你自己的服务端。
一个 Web 标准 fetch handler，跑在哪都行：Node / Cloudflare Workers / Vercel / Deno。

## 协议

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 自检：`{ name, ok, keyConfigured }` |
| `/whisper` | GET | 一句碎碎念 → `{ line, source }`（`source`: `deepseek` \| `local`）。可选参数 `?title=&path=`：客户端把当前页面标题/路径带上，AI 能就着访客正在看的内容说话 |
| `/chat` | POST | 流式对话：请求体 `{ messages: [{role, content}...] }`（最多 10 条、单条 ≤500 字），响应 SSE |

SSE 事件流（与 dafeiyu 客户端约定）：

```
data: {"d":"增量文本"}
data: {"e":"错误信息"}
data: [DONE]
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 想要 AI | [platform.deepseek.com](https://platform.deepseek.com) 获取；不配则全降级本地台词，服务照常 |
| `PERSONA` | 否 | 人设正文覆盖（默认通用「网页宠物大肥鱼」，会自动追加名字与实时时间背景） |
| `ALLOW_ORIGIN` | 否 | CORS 允许来源，默认 `*`；锁定为 `https://你的域名/` 可防蹭 |
| `PORT` | 否 | 仅 Node 运行器，默认 8787 |

## 部署

### Node（任意机器/容器）

```bash
git clone https://github.com/huangqi-an/dafeiyu-server && cd dafeiyu-server
DEEPSEEK_API_KEY=sk-xxx PORT=8787 node node.js
```

### Cloudflare Workers（免费额度足够个人站）

```bash
git clone https://github.com/huangqi-an/dafeiyu-server && cd dafeiyu-server/cloudflare
wrangler secret put DEEPSEEK_API_KEY
wrangler deploy
```

### Vercel

把本仓库导入 Vercel 即可——根目录 `api/[[...route]].js` 会被自动识别为 edge function，
然后在项目 Settings → Environment Variables 配 `DEEPSEEK_API_KEY`。

### Deno Deploy

新建项目指向本仓库，入口文件选 `deno.ts`，再在项目设置里配 `DEEPSEEK_API_KEY`。

## 前端接入（dafeiyu 客户端）

```html
<script src=".../dafeiyu.iife.js"></script>
<script>
  Dafeiyu.mount({
    assetBase: '.../assets/',
    endpoints: {
      whisper: 'https://你的部署地址/whisper',
      chat: 'https://你的部署地址/chat'
    }
  })
</script>
```

不配 `endpoints` 也能用宠物（本地台词池），只是没有双击聊天。

## 行为细节

- **模型**：`deepseek-flash`，思考模式显式关闭（闲聊不需要，先思考再回答既慢又按输出计费）
- **时间感知**：system 提示词每次现算日期/星期/时段/工作日，碎碎念能说出「周五下午了」这种话
- **限流**：单实例内存计数——whisper 6 次/10 分钟/IP、chat 20 次/10 分钟/IP、全局 1000 次/天封顶费用。
  Serverless（Workers/Vercel）实例是弹性的，跨实例不保证，介意的话在网关层再加；
  或者把 `ALLOW_ORIGIN` 锁成自己的域名，配合各平台的 WAF 规则
- **降级**：未配 key / 上游失败 / 超限时，whisper 返回本地台词（宠物不断话），chat 返回明确错误由前端转成气泡提示

## License

MIT
