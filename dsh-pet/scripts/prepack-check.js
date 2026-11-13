#!/usr/bin/env node
/** Verify that the Windows application build contains only standalone runtime assets. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fail = (message) => {
  console.error(`[desktop-package-check] FAIL: ${message}`);
  process.exitCode = 1;
};
const ok = (message) => console.log(`[desktop-package-check] ok: ${message}`);

const required = [
  'lib/index.js', // 宿主半侧
  'lib/client.js', // 浏览器半侧
  'lib/types/index.d.ts', // 宿主类型声明
  'lib/types/client/index.d.ts', // 客户端类型声明
  'cordis.patch.yml', // bundle patch（挂载声明）
  'runtime/electron-helper/main.js', // 桌面模式 Electron 主进程
  'runtime/electron-helper/main/smoke.js', // 桌面模式冒烟自检（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/dpi.js', // 桌面模式 DPI 与指针（main.js require，缺了启动即崩）
  'runtime/electron-helper/main/bridge.js', // 桌面模式与宿主通道（同上）
  'runtime/electron-helper/main/tray.js', // 桌面模式托盘（同上）
  'runtime/electron-helper/main/windows.js', // 桌面模式窗口与两条实时泵（同上）
  'runtime/electron-helper/main/ipc.js', // 桌面模式 ipc 处理器（同上）
  'runtime/electron-helper/main/displays.js', // 桌面模式显示器热更新（同上）
  'runtime/electron-helper/main/user-data.js', // 桌面模式 userData 回退决策（main.js require，缺了会启动即崩）
  'runtime/electron-helper/pointer-target.js', // 桌面模式点击穿透兜底判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/host-liveness.js', // 桌面模式宿主存活判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/topmost-watchdog.js', // 桌面模式置顶看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/taskbar-watchdog.js', // 桌面模式任务栏看门狗判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/dpi-linearization.js', // 桌面模式 DPI 线性化判定与换算（main.js require，缺了会启动即崩）
  'runtime/electron-helper/tray-platform.js', // 桌面模式托盘平台差异判定（main.js require，缺了会启动即崩）
  'runtime/electron-helper/desktop-geometry.js', // 活动边界与菜单工作区分离
  'runtime/electron-helper/preload.js', // 桌面模式 preload 桥
  'runtime/electron-helper/renderer.js', // 桌面模式渲染端（宠物本体）
  'runtime/electron-helper/sprite/bubble.js', // 桌面模式气泡与提示渲染（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/menu.js', // 桌面模式右键菜单（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/sprite/playback.js', // 桌面模式播放状态机（同上）
  'runtime/electron-helper/sprite/motion.js', // 桌面模式运动驱动（同上）
  'runtime/electron-helper/sprite/input.js', // 桌面模式指针与命中（同上）
  'runtime/electron-helper/sprite/init.js', // 桌面模式构建期初始化（同上）
  'runtime/electron-helper/sprite/window-fit.js', // 桌面模式窗口落位与钳制补偿（sprite.js 的原型扩展，须在其后加载）
  'runtime/electron-helper/shared-core.js', // 桌面模式共享纯逻辑（src/shared 构建产物，window.PetShared）
  'runtime/electron-helper/index.html', // 桌面模式页面壳
];
for (const file of required) {
  existsSync(join(ROOT, file)) ? ok(`exists ${file}`) : fail(`missing ${file}`);
}

// 待机动画是播放链的起点，缺了宠物立不起来；浏览器与桌面 Helper 共用这一份 webm。
const idleWebm = join(ROOT, 'assets', 'webm', '待机呼吸休闲.webm');
existsSync(idleWebm) ? ok('idle webm present') : fail('missing 待机呼吸休闲.webm thumb');

// 原始母版（1200×1200）体积超限，应放 GitHub Releases，不进 npm 包。
// assets/ 根下若有 .webm 就是原始母版，播放素材在 assets/webm|mov 子目录。
const originals = [];
const assetsRoot = join(ROOT, 'assets');
for (const name of readdirSync(assetsRoot)) {
  if (name.endsWith('.webm')) originals.push(name);
}
if (originals.length > 0)
  fail(`original masters must not ship in npm package: ${originals.join(', ')} (move them to GitHub Releases)`);
else ok('no original masters in assets/');

// 宿主加载器只认官方 bundle 形态；形制不对，插件在浏览器半侧根本注册不上。
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
client.includes('__ModuleLoader__.load')
  ? ok('client bundle shell OK')
  : fail('client.js missing __ModuleLoader__.load');
const exportsPlugin =
  /exports\.(apply|inject|name)/.test(client) || /module\.exports\s*=\s*\{[^}]*apply[^}]*inject[^}]*name/.test(client);
exportsPlugin ? ok('client exports apply/inject/name') : fail('client.js missing apply/inject/name exports');

// 两项声明缺任一个都装不进宿主：bundle 声明决定挂载声明，client 声明决定浏览器半侧注入。
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dsh?.bundle?.patch) ok('dsh.bundle.patch declared');
else fail('package.json missing dsh.bundle.patch');
if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.web declared');
else fail('package.json missing dsh.client platform web');

// 配图功能只读包内 assets/memes，漏发即整体失效。
// scripts/prepare.js 每次发布都用硬编码白名单覆盖 package.json 的 files，
// 只在 package.json 里加一行是无效的，故这里显式断言，防止再次静默漏发。
const memesDir = join(ROOT, 'assets', 'memes');
if (Array.isArray(pkg.files) && pkg.files.includes('assets/memes')) ok('files includes assets/memes');
else fail('package.json files must include assets/memes (meme images would not ship)');
const memePngs = existsSync(memesDir) ? readdirSync(memesDir).filter((n) => n.endsWith('.png')) : [];
if (memePngs.length > 0) ok(`meme images present (${memePngs.length} png)`);
else fail('no png in assets/memes (whisper/chat 配图会整体失效)');
// memes 键 ↔ 图片文件对齐：缺图条目会被 host 静默剔除（设计如此，不阻断发布），
// 但数字对不上值得发布前看一眼，故只提示
try {
  const conf = JSON.parse(stripJsonc(readFileSync(join(ROOT, 'assets', 'config.jsonc'), 'utf8')));
  const keys = Object.keys(conf.memes ?? {});
  const onDisk = new Set(memePngs.map((n) => n.slice(0, -'.png'.length)));
  const missing = keys.filter((k) => !onDisk.has(k));
  const extra = [...onDisk].filter((k) => !keys.includes(k));
  if (!missing.length && !extra.length) ok(`memes mapping aligned (${keys.length} keys = ${memePngs.length} png)`);
  else
    console.log(
      `[prepack-check] note: memes 键与图片不齐 —— 缺图 ${missing.length} 条${
        missing.length ? `（${missing.join('、')}）` : ''
      }；没写进配置的图 ${extra.length} 张${extra.length ? `（${extra.join('、')}）` : ''}`,
    );
} catch (e) {
  console.log(`[prepack-check] note: 跳过 memes 键对齐核对（config.jsonc 解析失败：${e.message}）`);
}

// 角色参考图：/character 的包内兜底只读这张图，漏发则第三方拿不到任何官方参考图。
// 与 memes 同一类问题——prepare.js 的白名单才是真源，这里显式断言防止再次静默漏发。
const characterFile = 'assets/main-character.png';
if (Array.isArray(pkg.files) && pkg.files.includes(characterFile)) ok(`files includes ${characterFile}`);
else fail(`package.json files must include ${characterFile} (character reference would not ship)`);

// 估算将进包的总大小：跳过 node_modules、.git、脚本、母版目录与 preview，
// 另不计 sourcemap 与 npm pack 遗留的 tarball。
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过不会进 npm 包的目录
      // dist-app 是 electron-builder 的本地产物（.gitignore 已忽略、不进包），不参与体积估算。
      if (
        !['node_modules', '.git', 'scripts', 'step01', 'step02', 'step03', 'preview', 'dist-app'].includes(entry.name)
      ) {
        walk(p);
      }
    } else if (!entry.name.endsWith('.map')) {
      // 打包产物 tarball（npm pack 遗留）不计入自查口径
      if (!entry.name.endsWith('.tgz')) total += statSync(p).size; // sourcemap 不计
    }
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.private === true) ok('package is private and cannot be published as a DSH Web plugin');
else fail('package.json must set private=true');
if (!pkg.dsh) ok('no DSH plugin registration metadata');
else fail('package.json still contains DSH plugin registration metadata');
if (!pkg.exports?.['./client']) ok('no browser client export');
else fail('package.json still exports a DSH Web client');
const runtimeDshDependencies = ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((section) =>
  Object.keys(pkg[section] ?? {}).filter((name) => name.startsWith('@deepseek-ai/')),
);
if (runtimeDshDependencies.length === 0) ok('no DSH runtime dependencies are bundled into the EXE');
else fail(`DSH-only build dependencies must stay out of the EXE: ${runtimeDshDependencies.join(', ')}`);

const packagedFiles = Array.isArray(pkg.files) ? pkg.files : [];
for (const file of ['lib/standalone.js', 'lib/standalone-settings.js', 'lib/*.js', 'runtime/electron-helper']) {
  if (packagedFiles.includes(file)) ok(`package file list includes ${file}`);
  else fail(`package file list is missing ${file}`);
}
for (const file of ['lib/**', 'src', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js']) {
  if (packagedFiles.includes(file)) fail(`package file list must exclude ${file}`);
}
for (const file of ['cordis.patch.yml', 'tsconfig.types.json', 'scripts/gen-types.mjs', 'lib/client.js', 'lib/index.js', 'lib/types']) {
  if (existsSync(join(ROOT, file))) fail(`obsolete DSH Web source/build residue remains: ${file}`);
  else ok(`no obsolete DSH Web residue at ${file}`);
}

for (const config of ['electron-builder.yml', 'electron-builder.public.yml']) {
  const content = readFileSync(join(ROOT, config), 'utf8');
  if (content.includes('lib/**')) fail(`${config} includes all lib outputs`);
  else ok(`${config} excludes unneeded bundles`);
  if (
    content.includes('lib/standalone.js') &&
    content.includes('lib/standalone-settings.js') &&
    content.includes('lib/*.js')
  ) {
    ok(`${config} includes the EXE host, settings page, and generated runtime chunks`);
  } else fail(`${config} is missing EXE bundles`);
  if (content.includes('cordis.patch.yml') || content.includes('lib/client.js')) {
    fail(`${config} includes a DSH Web plugin entry`);
  }
}

const publicBuilder = readFileSync(join(ROOT, 'electron-builder.public.yml'), 'utf8');
const packageFiles = Array.isArray(pkg.files) ? pkg.files : [];
for (const file of ['assets/dsh-pet-icon-16.png', 'assets/dsh-pet-icon-256.png', 'assets/dsh-pet-icon.ico']) {
  if (publicBuilder.includes(file)) fail(`public EXE must exclude the personal icon resource ${file}`);
  else ok(`public EXE excludes personal icon resource ${file}`);
  if (packageFiles.includes(file)) fail(`published package file list must exclude the personal icon resource ${file}`);
}

if (process.exitCode) console.error('\n[desktop-package-check] fix the failures before building the EXE.');
else console.log('\n[desktop-package-check] standalone package contents are ready.');
