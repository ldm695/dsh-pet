# DSH Pet Work Status Bridge

这是供 **DSH Desktop** 使用的独立桥接插件。它监听会话和并行 Agent 的工作状态，并将状态写入 `$DSH_HOME/dsh-pet/work-status-bridge.json`，供 DSH Pet Windows 应用读取。

本插件只负责状态与焦点上报，不渲染桌宠，也不向 DSH Web 注入 DSH Pet 覆盖层。DSH Desktop 使用 Web 技术承载界面，因此插件保留一个轻量 Web UI 客户端，用于报告当前选中的会话和窗口焦点；该客户端不会显示任何桌宠。

## 多 Agent 分配

- DSH 开始工作时，桌宠应用会从启用「工作状态联动」的空闲桌宠中动态分配一只，并在工作期间保持该绑定。
- DSH 的主会话、并行 Agent 与子代理汇总为一个 DSH 客户端状态，因此 DSH 同时最多占用一只桌宠。不同客户端可各自占用空闲桌宠；桌宠不足时，尚未分配的客户端等待空位。
- 成功或错误状态最多保留 60 秒以播放结束动画；中断状态立即清除。若 DSH 没有发送结束事件，活动状态最多保留两小时。
- Agent 标识以哈希形式写入桥接文件。状态文件不含提示词、对话正文、工具参数或工作区路径。

## 通知与焦点

DSH Desktop 客户端每两秒报告当前选中的会话和焦点状态，并在焦点变化时立即报告。该选择只决定通知来源，子代理和委派会话不会单独产生通知。完成、失败、权限申请和待回答问题的通知内容会临时写入桥接文件，最多保留 15 秒，不保存会话历史。桌宠应用的「系统通知」总开关和窗口失焦条件仍会控制是否显示通知。

桌宠应用会分别读取 DSH、Codex 和 Claude Code 的桥接文件；同一客户端的多个会话和 Agent 会合并为一个工作状态。

## 安装到 DSH Desktop

请在 DSH Desktop 使用的 PowerShell 终端中安装，并将路径替换为本仓库内此目录的绝对路径：

```powershell
dsh plugin --profile desktop add "D:\path\to\dsh-pet\dsh-pet-work-status-bridge"
```

不要将此插件安装到 `web` profile。安装或更新后重启 DSH Desktop，并在 DSH Pet 设置中启用「工作状态联动」。插件版本为 `0.2.0`。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-pet-work-status-bridge
```

此桥接插件独立于 DSH Pet 主应用；不需要安装或加载 DSH Pet Web 插件。
