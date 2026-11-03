// 运行环境：正常版（本机 Gateway）/ 在线体验（官网 /preview/，vite --mode demo 构建：没有后端，数据是录制的行情样本，不能连接钱包或下单）
export const DEMO = import.meta.env.MODE === 'demo'
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
/** 官网页面里嵌入的展示画面（iframe）：不显示提示条；按 ?w= 的设计宽度缩放到 iframe 大小 */
export const EMBED = DEMO && q.has('embed')
/** 在线体验的地址参数（每次读当前地址：嵌入画面会在页面内跳转） */
export const demoParam = (k: string) => (DEMO ? new URLSearchParams(location.search).get(k) : null)
/** public 目录里的静态文件（图标、平台角标、音效）：在线体验部署在 /preview/ 下，路径要带上前缀 */
export const asset = (p: string) => import.meta.env.BASE_URL + p.replace(/^\//, '')
