# 安装与构建说明

本 Fork 提供 Windows x64 Portable 桌宠应用。DSH Pet 不再作为 DSH Web 插件加载；DSH Web 本身仍可正常使用，只是不显示本项目的桌宠覆盖层。

## 安装 Windows 应用

从 [GitHub Releases](https://github.com/ldm695/dsh-pet/releases) 下载 Windows x64 Portable 文件并运行，无需安装向导。桌宠启动后可右键打开设置页。设置中的显示选项为「仅桌面」和「不显示」。

配置和用户数据默认保存在 `%USERPROFILE%\.dsh\dsh-pet\`；设置了 `DSH_HOME` 时使用该目录。Windows 下独立 AI 设置保存的 API Key 使用当前用户 DPAPI 加密。

### 从旧版升级到 0.3.7-ldm.12（必须按顺序）

升级到 `0.3.7-ldm.12` 前，必须先实际运行 `0.3.7-ldm.11` 一次。当前版本早于 `.11` 的用户，请先下载并运行 [`.11` 大众版](https://github.com/ldm695/dsh-pet/releases/tag/dsh-pet-0.3.7-ldm.11)；如果已经是 `.11`，也要确保它至少启动过一次并完成迁移。只下载或解压 `.11` 不会执行迁移。

`.11` 负责把旧主配置文件迁移到当前路径，并把旧独立 AI 密钥迁移到加密存储。运行后先确认桌宠列表和已有设置仍然存在；如果以前配置过独立 AI，也请测试连接，确认服务可用。若出现迁移失败提示、设置丢失或 AI 无法连接，先停留在 `.11` 并处理问题，不要继续升级。

`.12` 首次启动还会整理 `.11` 未落盘的显示位置旧值和对话上下文格式；这一步不能代替 `.11` 对旧主配置路径和旧密钥的迁移。完成 `.11` 检查后，再下载并运行 `.12`。为让仍在旧版的用户能完成这条升级路径，`.11` Release 会继续保留。

GitHub Releases 只提供大众版 EXE 和公开桥接插件。个人版及其专属资源仅保留在维护者本机，不会上传到公开 Release。

## 从源码构建

需要 Windows x64、Git、Node.js `22.12.0` 或更高版本，以及 pnpm 11。

```powershell
git clone https://github.com/ldm695/dsh-pet.git
Set-Location .\dsh-pet\dsh-pet
pnpm install --frozen-lockfile
pnpm run build:exe
```

`build:exe` 默认构建大众版。Portable EXE 输出到 `dsh-pet\portable-dist\public\`。构建只打包 Windows 应用运行所需的桌面宿主、设置页、动画素材和 Electron Helper，不包含 DSH Pet 的 Web 客户端或插件注册文件。个人版通过 `build:exe:personal` 显式构建，仅供维护者本机使用，不上传到公开 Release。

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
