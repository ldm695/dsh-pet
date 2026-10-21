# DSH Pet

DSH Pet 是面向 Windows 的便携桌面宠物应用。它使用 Electron 透明窗口独立运行，不需要打开 DSH，也不会把桌宠覆盖层注入 DSH Web 页面。

本 Fork 基于上游 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 维护。DSH Web 本身仍可正常运行；本项目不再注册或加载 DSH Pet Web 插件。DSH Desktop 的工作状态与焦点桥接仍可选用，桥接客户端只上报会话和焦点信息，不渲染桌宠。

## 安装

从 [GitHub Releases](https://github.com/ldm695/dsh-pet/releases) 下载 Windows x64 Portable 文件并运行。应用无需安装向导，启动后桌宠直接显示在桌面。右键桌宠可打开设置页、播放动作、查看余额或退出应用。

GitHub Releases 仅发布大众版。个人版及其专属图标保留在维护者本机，不包含在公开安装包和公开桥接插件压缩包中。

设置页和托盘菜单中的显示选项为「仅桌面」与「不显示」。旧配置会自动兼容：`both` 转为 `desktop`，`web` 转为 `none`。

配置和用户数据默认位于 `%USERPROFILE%\.dsh\dsh-pet\`；若设置了 `DSH_HOME`，则使用对应目录。独立 AI 设置可配置 DeepSeek、OpenAI 兼容或 Anthropic 接口。Windows 上保存的 API 密钥使用当前用户 DPAPI 加密；密钥不会从设置页回显。旧版保存在 JSON 中的明文密钥会在成功迁移到 DPAPI 后移除；迁移失败时会保留原文件并记录提示。

环境变量 `DSH_PET_STANDALONE_DEEPSEEK_API_KEY` 可作为 DeepSeek 余额查询的环境密钥；首次配置独立 AI 时也可作为初始密钥，保存后写入 DPAPI 加密存储。旧版通用环境变量 `DEEPSEEK_API_KEY` 已停止读取；请改用应用专用变量或独立 AI 设置页。

设置页分为「桌宠设置」「全局设置」和「独立 AI 设置」。全局设置中的主题选项同时控制设置页和桌宠右键菜单；选择「自适应主题」时跟随 Windows 外观。

## 功能

- 多只桌宠、透明动画、点击、拖拽、抛掷和桌面移动；两次左键按下间隔小于 200ms，第二下按住拖拽可使用弹弓反向发射。
- 每只桌宠可单独填写 AI 人设，留空时跟随所属配置；名字和当前时间自动追加。
- 第三方应用可注册右键「更多」菜单项，并通过本机 API 写入工作状态。
- 额度型余额气泡支持点击展开完整窗口额度；动画格式按渲染端选择，缺失 mov 时回落 webm。
- 桌宠右键菜单、托盘显示控制、全屏或最大化窗口隐藏策略、字体与外观设置。桌宠抛掷和移动的落地边界会避开 Windows 任务栏。
- 独立模式 AI 可设置 OpenAI 兼容或 Anthropic 协议、模型端点、密钥与模型，并在设置页测试连接；测试不会保存尚未提交的配置。
- 自动碎碎念需同时启用 AI、打开独立 AI 设置中的自动碎碎念开关，并为对应桌宠启用碎碎念；手动触发不受自动碎碎念开关影响。
- 可选的工作状态联动：DSH Desktop、Codex 和 Claude Code 各自通过独立桥接插件上报状态。
- 支持自定义动画、表情包和额外桌宠种类。
- 本机 HTTP API 默认监听 `127.0.0.1:6952`，用于应用设置、桌面 Helper 和本机集成。

## 工作状态桥接插件

桥接插件与桌宠应用分开安装。DSH 插件安装到 **DSH Desktop profile**；Codex 和 Claude Code 插件分别安装到对应客户端。安装说明：

- [DSH Desktop 工作状态桥接](./dsh-pet-work-status-bridge/README.md)
- [Codex 工作状态桥接](./codex-pet-work-status-bridge/README.md)
- [Claude Code 工作状态桥接](./claude-code-pet-work-status-bridge/README.md)

启用桌宠设置中的「工作状态联动」后即可使用。每个客户端将自己的多个会话与 Agent 合并为一个工作状态；桌宠数量不足时，未分配的客户端等待空位。DSH Desktop 桥接还可在窗口失焦时转发当前会话的通知。

工作状态桥接使用 `version: 2` 和 `agents[]` 数据格式。旧版桥接文件不会再按单状态格式兼容；检测到旧版时，应用日志会提示更新对应插件。请升级 DSH Desktop、Codex 或 Claude Code 的桥接插件后再使用工作状态联动。

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
