// Piupiu Pass 的 HTTP 接口（engine/live/pass.js）。只有实盘且已配置合约时可用；没配置时 /api/pass 返回 available:false，界面不显示入口。
export function passRoutes(app, { getPass, LIVE }) {
  const err = (res, e) => res.status(400).json({ error: e.message });
  app.get('/api/pass', async (req, res) => {
    const p = getPass();
    if (!LIVE || !p?.available) return res.json({ available: false });
    try { res.json(await p.view()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/pass/preview', async (req, res) => {
    if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
    try { res.json(await getPass().preview({ slot: Number(req.body?.slot) })); } catch (e) { err(res, e); }
  });
  app.post('/api/pass/submit', async (req, res) => {
    if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
    try { res.json(await getPass().submit({ previewId: String(req.body?.previewId || '') })); } catch (e) { err(res, e); }
  });
}
