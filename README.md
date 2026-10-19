# DSH Pet

> **上游项目：** [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)

本仓库基于上游项目开发，维护 Windows 便携桌面应用，以及桌面交互和工作状态联动相关功能。

本 Fork 不再将 DSH Pet 注册为 DSH Web 插件；DSH Web 可照常运行，但不会加载桌宠覆盖层。DSH Desktop 的会话与焦点上报桥接仍保留，用于独立 EXE 的工作状态和通知判断。

本项目保留上游代码的署名与许可要求。Fork 维护的改动见[改动说明](FORK_CUSTOMIZATIONS.md)。

## 功能概览

- **Windows 便携应用：** 使用 Electron 透明窗口独立运行，无需启动 DSH。
- **桌面交互：** 支持多只桌宠、拖动与抛掷、屏幕范围移动、窗口显示优先级设置和单例设置窗口。
- **设置与 AI 接口：** 可配置 DeepSeek API Key 和模型。Windows 下使用 DPAPI 保护 API Key；独立服务默认使用端口 `6952`。
- **字体设置：** 字体种类应用于桌宠气泡、悬浮提示、对话窗口和得分弹窗；字号设置应用于气泡与悬浮提示。
- **工作状态联动：** 提供 DSH、Codex 和 Claude Code 的可选桥接插件。每个客户端来源同时最多分配一只桌宠；同一客户端的多个会话或 Agent 会合并处理。
- **配置与素材：** 支持按宠物配置、自定义动画和额外宠物种类。

## 文档

- [安装与构建说明](INSTALL.md)
- [Fork 改动说明](FORK_CUSTOMIZATIONS.md)
- [HTTP API 概览](API.md)与 [OpenAPI 规范](openapi.yaml)
- [应用与功能说明](dsh-pet/README.md)

工作状态桥接插件需要按需单独安装：

- [DSH Desktop 工作状态桥接插件](dsh-pet/dsh-pet-work-status-bridge/README.md)
- [Codex 桥接插件](dsh-pet/codex-pet-work-status-bridge/README.md)
- [Claude Code 桥接插件](dsh-pet/claude-code-pet-work-status-bridge/README.md)

## 平台范围

本仓库构建的独立便携版面向 Windows x64。此范围不改变上游插件的兼容性说明；本 Fork 的独立版目前未声明支持 Linux 或 macOS。

## 问题反馈

请通过 [GitHub Issues](https://github.com/ldm695/dsh-pet/issues) 提交本 Fork 相关问题，并提供应用版本、操作系统和复现步骤。若问题涉及上游原有功能，也请参考[上游仓库](https://github.com/PC2005-cloud/dsh-pet)。
