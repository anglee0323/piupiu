// 雷达里以中文原文存进缓存的固定标签 → 稳定编号（用来取 shared/i18n 的文案键）。
// 源码风险项（engine/live/radar/source.js 的 RISKY）和代理类型（chain.js）都按原文反查，旧缓存不用迁移。
// 新增风险项 / 代理类型时同时加在这里和两份字典（risk.* / px.*），radar 测试会核对。
export const RISK_ID = {
  '可以改价格 / 费用': 'price',
  '可以暂停 / 开关铸造': 'pause',
  '管理员可以自己铸造 / 空投': 'ownerMint',
  '可以改总量': 'supply',
  '合约可升级（规则可能整个被换掉）': 'upgrade',
  '可以提走合约里的资金': 'withdraw',
  '可以拉黑地址': 'blacklist',
  '可以改 NFT 图片 / 元数据': 'uri',
  '可以改交易税': 'tax',
};
export const PROXY_ID = {
  '克隆（EIP-1167）': 'clone',
  '可升级代理（EIP-1967）': 'upgradeable',
  '信标代理': 'beacon',
};
export const riskId = (label) => RISK_ID[label] || null;
export const proxyId = (kind) => PROXY_ID[kind] || null;
// 模拟 / 预检失败时网关自己写的中文原因（合约回滚的原文不翻译）
export const REASON_ID = {
  '余额不够': 'funds',
  '模拟失败': 'sim',
  '节点不支持临时余额': 'noOverride',
  '原因未知': 'unknown',
};
export const reasonId = (r) => REASON_ID[r] || null;
