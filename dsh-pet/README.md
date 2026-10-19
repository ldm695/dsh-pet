# DSH Pet

DSH Pet 是面向 Windows 的便携桌面宠物应用。它使用 Electron 透明窗口独立运行，不需要打开 DSH，也不会把桌宠覆盖层注入 DSH Web 页面。

本 Fork 基于上游 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 维护。DSH Web 本身仍可正常运行；本项目不再注册或加载 DSH Pet Web 插件。DSH Desktop 的工作状态与焦点桥接仍可选用，桥接客户端只上报会话和焦点信息，不渲染桌宠。

## 安装

从 [GitHub Releases](https://github.com/ldm695/dsh-pet/releases) 下载 Windows x64 Portable 文件并运行。应用无需安装向导，启动后桌宠直接显示在桌面。右键桌宠可打开设置页、播放动作、查看余额或退出应用。

设置页和托盘菜单中的显示选项为「仅桌面」与「不显示」。旧配置会自动兼容：`both` 转为 `desktop`，`web` 转为 `none`。

配置和用户数据默认位于 `%USERPROFILE%\.dsh\dsh-pet\`；若设置了 `DSH_HOME`，则使用对应目录。保存的 DeepSeek API Key 在 Windows 上通过当前用户 DPAPI 加密。

## 功能

- 多只桌宠、透明动画、点击、拖拽、抛掷和桌面移动。
- 桌宠右键菜单、托盘显示控制、全屏隐藏、字体与外观设置。
- 可选的工作状态联动：DSH Desktop、Codex 和 Claude Code 各自通过独立桥接插件上报状态。
- 支持自定义动画、表情包和额外桌宠种类。
- 本机 HTTP API 默认监听 `127.0.0.1:6952`，用于应用设置、桌面 Helper 和本机集成。

## 工作状态桥接插件

桥接插件与桌宠应用分开安装。DSH 插件安装到 **DSH Desktop profile**；Codex 和 Claude Code 插件分别安装到对应客户端。安装说明：

- [DSH Desktop 工作状态桥接](./dsh-pet-work-status-bridge/README.md)
- [Codex 工作状态桥接](./codex-pet-work-status-bridge/README.md)
- [Claude Code 工作状态桥接](./claude-code-pet-work-status-bridge/README.md)

启用桌宠设置中的「工作状态联动」后即可使用。每个客户端将自己的多个会话与 Agent 合并为一个工作状态；桌宠数量不足时，未分配的客户端等待空位。DSH Desktop 桥接还可在窗口失焦时转发当前会话的通知。

## 从源码构建

需要 Windows x64、Node.js `22.12.0` 或更高版本及 pnpm 11：

```powershell
pnpm install --frozen-lockfile
pnpm run build:exe:public
```

Portable EXE 输出到 `portable-dist/`。构建仅包含 EXE 使用的独立宿主、内嵌设置页、桌面 Helper 和素材；不生成 DSH Pet 浏览器客户端或 DSH 插件注册文件。

## 相关文档

- [仓库安装与构建说明](../INSTALL.md)
- [HTTP API 概览](../API.md)
- [Fork 改动说明](../FORK_CUSTOMIZATIONS.md)
- [上游项目](https://github.com/PC2005-cloud/dsh-pet)
