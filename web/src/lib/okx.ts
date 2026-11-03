// OKX NFT 市场（web3.okx.com）：BNB 链的合集页 / 单个 NFT 页都能按合约地址直接打开（Element 的合集页做不到）。
// 币安 Agentic 钱包连不上网页市场：要挂单，先把 NFT 转到自己的 OKX 钱包（资产页 → NFT → 转出），再在 OKX 里挂单。
export const okxCollectionUrl = (contract: string) => `https://web3.okx.com/zh-hans/nft/collection/bsc/${contract.toLowerCase()}`
export const okxAssetUrl = (contract: string, id: string) => `https://web3.okx.com/zh-hans/nft/asset/bsc/${contract.toLowerCase()}/${id}`
