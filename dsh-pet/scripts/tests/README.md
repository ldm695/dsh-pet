# 设置页浏览器回归

在 `dsh-pet/` 包目录运行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
npm run test:ui
```

Linux CI 缺少系统库时用 `pnpm exec playwright install --with-deps chromium`。

测试用真实 React 和 Chromium 渲染设置页，拦截配置与模型接口，验证加载、失败重试、恢复默认与保存，以及中英文窄窗口布局。只访问临时本地服务，不读取或修改用户的 DSH 配置。与 `npm test` 的 Node 单元测试分开运行，普通插件安装不下载浏览器。

可选设置 `DSH_PET_UI_ARTIFACTS` 为输出目录，保存布局截图。桌面 Electron 窗口、操作系统点击穿透和显示器缩放仍需另做运行时测试。

桌面终点协调的状态和动画调度回归可以单独运行，无需浏览器：

```sh
node --test scripts/tests/move-targets.test.mjs scripts/tests/move-endpoints-renderer.test.mjs
```

覆盖移动途中交叉、A/B/C 同终点的发起顺序、稳定占位优先级、`O` 标记驱动让位、让位不转移标记、无空位时选最大间距并保留 `O`、手动动作与边界反向、取消后的位置恢复，以及拖拽/抛掷期间暂停占用。调度测试直接加载桌面精灵与共享几何代码，使用受控视频时钟验证终点登记、释放和动画结束的先后顺序。
