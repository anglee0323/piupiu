// 登录检查的退避：正常情况每 10 秒查一次；连续失败时间隔翻倍（20 秒、40 秒…），最长 5 分钟。
// 2026-10-30 桌面版实测：读不到登录凭证时每 10 秒重试，每次都新起一个 baw 进程，macOS 对每个进程弹一次钥匙串授权，1 分半弹了 27 次。
// 用户点「重新检查」、扫码登录完成时会直接调用 checkAuth，不受这里限制。
export const AUTH_BASE_MS = 10_000;
export const AUTH_MAX_MS = 5 * 60_000;
export function authBackoffMs(fails) {
  if (!fails || fails < 2) return 0;   // 偶发一次失败：照常 10 秒后再查（原有逻辑还会 3 秒后补查一次）
  return Math.min(AUTH_MAX_MS, AUTH_BASE_MS * 2 ** (fails - 1));
}
