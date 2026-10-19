# 安装与构建说明

本 Fork 提供 Windows x64 Portable 桌宠应用。DSH Pet 不再作为 DSH Web 插件加载；DSH Web 本身仍可正常使用，只是不显示本项目的桌宠覆盖层。

## 安装 Windows 应用

从 [GitHub Releases](https://github.com/ldm695/dsh-pet/releases) 下载 Windows x64 Portable 文件并运行，无需安装向导。桌宠启动后可右键打开设置页。设置中的显示选项为「仅桌面」和「不显示」。

配置和用户数据默认保存在 `%USERPROFILE%\.dsh\dsh-pet\`；设置了 `DSH_HOME` 时使用该目录。Windows 下保存的 DeepSeek API Key 使用当前用户 DPAPI 加密。

## 从源码构建

需要 Windows x64、Git、Node.js `22.12.0` 或更高版本，以及 pnpm 11。

```powershell
git clone https://github.com/ldm695/dsh-pet.git
Set-Location .\dsh-pet\dsh-pet
pnpm install --frozen-lockfile
pnpm run build:exe:public
```

Portable EXE 输出到 `dsh-pet\portable-dist\`。构建只打包 Windows 应用运行所需的桌面宿主、设置页、动画素材和 Electron Helper，不包含 DSH Pet 的 Web 客户端或插件注册文件。

## 工作状态桥接插件

桥接插件独立于桌宠 EXE，按需安装。DSH 桥接插件只安装到 **DSH Desktop profile**；它的 Web UI 客户端只报告当前会话和窗口焦点，不渲染桌宠。Codex 与 Claude Code 插件按各自文档安装，并在对应客户端审核和信任 hooks。

- [DSH Desktop 桥接插件](dsh-pet/dsh-pet-work-status-bridge/README.md)
- [Codex 桥接插件](dsh-pet/codex-pet-work-status-bridge/README.md)
- [Claude Code 桥接插件](dsh-pet/claude-code-pet-work-status-bridge/README.md)

启用 DSH Pet 设置中的「工作状态联动」后，三个客户端的工作状态可分别分配给空闲桌宠。一个客户端的多个会话和子代理合并为一个状态；桌宠不足时，未分配的客户端等待空位。

## 本机 HTTP API

Windows 应用启动后提供仅监听本机回环地址的 HTTP API，默认端口为 `6952`，供设置页、桌面 Helper 和本机集成使用。详见 [API 概览](API.md) 与 [OpenAPI 规范](openapi.yaml)。该 API 不会把桌宠注入 DSH Web 页面。

## 平台范围

本 Fork 的 Portable 应用面向 Windows x64。此范围不会扩展或取代上游项目对 DSH 插件的兼容性声明。
