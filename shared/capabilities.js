// 受币安钱包限制、暂时不可用的功能（网关和界面共用）。币安放开后改这里、发一次内核更新即可恢复，不用改各处界面。
// NFT 转出：币安钱包拦截一切通过开发者模式（合约调用）把 NFT 从 Agentic 钱包转出的请求（错误码 351803，预演阶段即被拒，
// 与收款地址无关）。2026-10-29 起实测如此；GMGN 等第三方同样不支持。
export const CAPS = Object.freeze({
  nftTransfer: Object.freeze({
    available: false,
    note: '币安目前不支持从 Agentic 钱包转出 NFT。NFT 会一直保存在钱包中，币安开放后此功能将自动恢复。',
    noteK: 'cap.nftTransfer',   // 界面按当前语言显示（shared/i18n）
  }),
});
