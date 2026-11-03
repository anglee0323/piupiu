// electron-builder 打包后、签名前：
//   1. 把整理好的 Gateway（build/gateway）和 App 自带的 npm（build/npm）原样拷进 resources/。
//      不用 extraResources：它总会跳过里面的 node_modules（Gateway 的 ethers / express、npm 自己的依赖），
//      装到用户电脑上一启动就找不到模块（在项目目录里测试时 Node 会往上层找到项目根的 node_modules，看不出来）。
//   2. macOS：清掉能清的扩展属性（Finder 信息等），否则 codesign 会报「detritus not allowed」。
//      注意：项目放在 iCloud 同步的目录里时，输出目录要放到不同步的地方（见 scripts/release.mjs），否则 iCloud 会再加上标记。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
exports.default = async (ctx) => {
  const mac = ctx.electronPlatformName === 'darwin';
  const res = mac ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(ctx.appOutDir, 'resources');
  const build = path.join(__dirname, 'build');
  for (const name of ['gateway', 'npm']) {
    const src = path.join(build, name), dst = path.join(res, name);
    if (!fs.existsSync(path.join(src, name === 'gateway' ? 'server.js' : 'bin/npm-cli.js'))) throw new Error(`desktop/build/${name} 不完整：先跑 node stage.mjs`);
    fs.rmSync(dst, { recursive: true, force: true });
    // 展开符号链接（cpSync 默认会把相对链接改写成指向 build/ 的绝对路径，签名会报「invalid destination for symbolic link」）；
    // node_modules/.bin 是命令行快捷方式，运行时用不到
    fs.cpSync(src, dst, { recursive: true, dereference: true, filter: (f) => path.basename(f) !== '.bin' });
    const nm = fs.readdirSync(path.join(dst, 'node_modules')).length;
    if (!nm) throw new Error(`${name}/node_modules 没拷进去`);
  }
  if (mac) { try { execFileSync('xattr', ['-cr', ctx.appOutDir]); } catch { /* 有些系统属性删不掉，签名时再看 */ } }
};
