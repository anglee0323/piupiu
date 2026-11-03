// 机会雷达 + 我的 NFT 的 HTTP 接口（从 server.js 拆出来）。
// 路由顺序有讲究：/history、/img/:addr 必须在 /:addr 之前，否则会被 /:addr 吃掉。
// getRadar：雷达实例在 server.js 里稍后才创建，接口里每次请求时再取。
import { createNftBatch } from '../live/radar/nftBatch.js';
import { CAPS } from '../../shared/capabilities.js';

export function radarRoutes(app, { getRadar, LIVE }) {
  const R = () => getRadar();
  const rErr = (res, e) => res.status(400).json({ error: e.message });
  // NFT 转出暂不可用（shared/capabilities.js）：所有转出接口直接拒绝，不去调币安钱包
  app.use(['/api/nft/transfer', '/api/radar/:addr/transfer'], (req, res, next) => (CAPS.nftTransfer.available ? next() : res.status(400).json({ error: CAPS.nftTransfer.note })));
  app.get('/api/radar', (req, res) => res.json(R().view()));
  app.post('/api/radar/settings', (req, res) => { try { res.json(R().setSettings(req.body || {})); } catch (e) { rErr(res, e); } });
  // 铸造历史独立于候选：冷却 / 隐藏 / 候选被清理的项目也能查（必须放在 /:addr 之前）
  app.get('/api/radar/history', (req, res) => { try { const n = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d); res.json(R().history({ limit: Math.min(500, n(req.query.limit, 100)), offset: n(req.query.offset, 0), address: req.query.address ? String(req.query.address).toLowerCase() : null })); } catch (e) { rErr(res, e); } });
  // 我持有的 NFT（资产页、顶部持仓条）。refresh=1 强制重读持仓
  app.get('/api/nft', async (req, res) => { if (!LIVE) return res.json({ at: Date.now(), rows: [], total: 0 }); try { res.json(await R().nftPortfolio({ force: !!req.query.refresh })); } catch (e) { rErr(res, e); } });
  // NFT 批量转出（engine/live/radar/nftBatch.js）：preview 逐个预检、汇总成批次；用户确认后 submit 按批次逐个提交
  let nb = null;
  const NB = () => (nb ||= createNftBatch({ part: R().part, getDest: () => R().part?.trader?.settings?.nftSendTo }));
  app.post('/api/nft/transfer/preview', async (req, res) => {
    if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
    const b = req.body || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(b.address || ''))) return res.status(400).json({ error: '合约地址不对' });
    try { res.json(await NB().preview({ address: b.address, items: b.items })); } catch (e) { rErr(res, e); }
  });
  app.post('/api/nft/transfer/submit', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await NB().submit({ batchId: req.body?.batchId })); } catch (e) { rErr(res, e); } });
  app.get('/api/radar/img/:addr', (req, res) => { const im = R().image?.(req.params.addr); if (!im || !/^image\//.test(im.type)) return res.status(404).end();
    // 图片来自陌生合约的元数据（可能是 SVG）：禁止其中的脚本 / 外链在本机源下执行
    res.set({ 'content-type': im.type, 'cache-control': 'max-age=600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }).send(im.body); });
  app.get('/api/radar/:addr', async (req, res) => { try { res.json(await R().detail(req.params.addr)); } catch (e) { rErr(res, e); } });
  app.post('/api/radar/:addr', (req, res) => { try { const b = req.body || {}; res.json(R().mark(req.params.addr, { follow: b.follow, block: b.block })); } catch (e) { rErr(res, e); } });
  app.post('/api/radar/:addr/links', (req, res) => { try { res.json({ links: R().addLinks(req.params.addr, req.body?.links || []) }); } catch (e) { rErr(res, e); } });
  app.post('/api/radar/:addr/analyze', (req, res) => { try { R().enqueue(req.params.addr, true, true); res.json({ ok: true }); } catch (e) { rErr(res, e); } });
  // 一键参与：先预检（每个钱包模拟 + 币安钱包预演，60 秒有效），再只提交预检通过且勾选了的
  app.post('/api/radar/:addr/preview', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const b = req.body || {}; res.json(await R().part.preview({ address: req.params.addr.toLowerCase(), slots: Array.isArray(b.slots) ? b.slots.map(Number) : null, qty: b.qty })); } catch (e) { rErr(res, e); } });
  app.get('/api/radar/:addr/holdings', async (req, res) => { if (!LIVE) return res.json({ rows: [] }); try { const a = req.params.addr.toLowerCase(); res.json(await R().part.holdings(a, R().cands.get(a)?.an)); } catch (e) { rErr(res, e); } });
  // 铸完之后转到常用钱包（同样两步：预检 → 确认提交）
  app.post('/api/radar/:addr/transfer/preview', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const b = req.body || {}; res.json(await R().part.transferPreview({ address: req.params.addr, slot: b.slot, tokenId: b.tokenId, to: b.to, amount: b.amount })); } catch (e) { rErr(res, e); } });
  app.post('/api/radar/:addr/transfer/submit', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await R().part.transferSubmit({ previewId: String(req.body?.previewId || '') })); } catch (e) { rErr(res, e); } });
  app.post('/api/radar/:addr/submit', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const b = req.body || {}; res.json(await R().part.submit({ previewId: String(b.previewId || ''), slots: Array.isArray(b.slots) ? b.slots.map(Number) : null, quick: b.quick === true })); } catch (e) { rErr(res, e); } });
}
