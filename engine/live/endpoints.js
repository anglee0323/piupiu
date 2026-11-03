// 外部数据源（开源版）：不内置任何地址，全部从环境变量（或 .env）读取，由部署者自行配置。
// 没配置的数据源，对应功能关闭（例如没有节点就无法读取行情，没有行情接口就不显示已开盘代币的价格）。
// 每一项的用途与接口要求见 docs/self-hosting.md「数据源」一节。
import './dotenv.js';

const one = (k) => String(process.env[k] || '').trim().replace(/\/+$/, '');
const many = (k) => String(process.env[k] || '').split(',').map((s) => s.trim()).filter(Boolean);
const slash = (k) => many(k).map((u) => (u.endsWith('/') ? u : `${u}/`));

export const EP = {
  rpcPublic: many('RPC_PUBLIC').length ? many('RPC_PUBLIC') : many('RPC_URL'),
  rpcLogs: one('RPC_LOGS') || one('RPC_URL') || many('RPC_PUBLIC')[0] || '',
  wssPublic: one('WSS_URL'),
  dexscreener: one('DEXSCREENER_API'),
  geckoterminal: one('GECKOTERMINAL_API'),
  binance: one('BINANCE_API'),
  binanceWeb3: one('BINANCE_WEB3_API'),
  gang: one('GANG_API'),
  shrine: one('SHRINE_API'),
  shrineWs: one('SHRINE_WS'),
  fsi: one('FSI_API'),
  fourStatic: one('FOUR_STATIC'),
  ipfs: slash('IPFS_GATEWAYS'),
  arweave: slash('ARWEAVE_GATEWAY')[0] || '',
  openchain: one('OPENCHAIN_API'),
  fourbyte: one('FOURBYTE_API'),
  sourcify: one('SOURCIFY_API'),
  translate: one('TRANSLATE_API'),
  spaceId: one('SPACEID_API'),
  xSearch: one('X_SEARCH_API'),
  fxtwitter: one('FXTWITTER_API'),
};

/** 数据源是否配置了（没配置时对应功能关闭） */
export const has = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
