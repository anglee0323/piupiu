// 品牌：Piupiu。Logo：单线条的「手指枪」（参考 Manus 的线条风格，手指向右），指尖三道 piu 线 + 小写衬线字标。
// 名字和 Logo 集中在这里（另外改 index.html 的 <title> 和 public/favicon.svg）
export const BRAND = { name: 'Piupiu', wordmark: 'piupiu', tagline: 'Agent ID 内盘终端' }   // i18n-ignore（未在界面显示）

/** 手指枪图标（单色，跟随文字颜色）：圆头等粗的单线条，手指向右，拇指饱满后倾、顺势接到食指，两节弯起的手指，指尖三道 piu 线。源文件在私有仓库 piupiu-cloud/brand/（mark.svg、黑版 / 白版图标） */
export function LogoMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="15.29 9.77 46.91 46.91" fill="none" stroke="currentColor" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <path d="M23.2 30.2C21.4 26.4 20.6 22.6 21.4 19.6C22.2 16.6 25.6 15.6 27.8 17.4C29.5 18.8 30.2 21.2 30.8 24.2Q31.4 27 34.4 27H47.4A3.9 3.9 0 0 1 47.4 34.8H37.4" />
        <path d="M37.4 34.8A3.2 3.2 0 0 1 37.4 41.2" />
        <path d="M37.4 41.2A3.2 3.2 0 0 1 37.4 47.6" />
        <path d="M23.2 30.2C17 33.4 16 44.2 21.4 48.1C25.4 51 32 50.2 37.4 47.6" />
        <path d="M54.6 23L57.2 20.4M55.8 30.9H59.6M54.6 38.8L57.2 41.4" />
    </svg>
  )
}

/** 顶栏 Logo：图标 + 小写衬线字标，颜色随主题（--color-brand） */
export function Logo() {
  return (
    <span className="flex items-center gap-1.5 select-none text-brand">
      <LogoMark size={30} />
      <span className="text-[21px] leading-none tracking-[-0.4px]" style={{ fontFamily: '"Piupiu Serif", Georgia, serif', fontWeight: 700 }}>{BRAND.wordmark}</span>
    </span>
  )
}
