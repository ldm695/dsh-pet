# DSH Pet Work Status Bridge（Claude Code）

将 Claude Code 的会话和并行子代理工作状态同步到 DSH Pet 独立版。插件使用 Claude Code lifecycle hooks 更新本地桥接文件；桌宠端将 Claude Code 的所有会话与子代理合并为一个客户端工作状态，因此同一时间最多占用一只桌宠。Codex 与 DSH 各自仍有独立客户端状态。

## 状态映射

| Claude Code 事件                                            | 桌宠状态                 |
| ----------------------------------------------------------- | ------------------------ |
| `UserPromptSubmit`                                          | 思考 `thinking`          |
| `PreToolUse`、`SubagentStart`                               | 工作 `working`           |
| `PostToolUse`、`PostToolUseFailure`、`PermissionDenied`     | 整理 `result`            |
| `PermissionRequest`、`Notification`（elicitation 对话/URL） | 等待 `waiting`           |
| `PreCompact`                                                | 思考 `thinking`          |
| `Stop`                                                      | 完成 `success`           |
| `SubagentStop`                                              | 释放已结束的子代理，不单独触发任务完成 |
| `StopFailure`                                               | 出错 `error`             |
| `Notification`（`idle_prompt`）                             | 清理已空闲会话的残留状态 |
| `SessionStart`（`source=compact`）                          | 思考 `thinking`          |
| 普通 `SessionStart`、`SessionEnd`                           | 清理当前会话状态         |

Claude Code 的用户中断不会触发 `Stop`。收到带 `is_interrupt=true` 的 `PostToolUseFailure` 后，插件会清除整个会话的根 Agent 与子代理状态，并抑制该会话的迟到事件，直到下一条 `UserPromptSubmit`。此外，插件会从最近一次 Hook 提供的 `transcript_path` 监视本地会话记录，只检查新追加的用户记录是否是 Claude Code 的中断标记；匹配后短暂等待并核对时间戳，再清理该会话，避免旧中断标记清掉已恢复的新任务。监听器不保存或上传会话记录内容。由于记录格式不是稳定的公开接口，`idle_prompt` 和 10 分钟超时仍作为兜底清理路径。后台 Agent 仍运行期间 Claude Code 不会发出空闲通知。

子代理的 Hook 事件和工具事件通过 `agent_id` 归属到该子代理；没有 `agent_id` 的事件归属于当前会话的主 Agent。桥接文件分别维护会话状态，宿主再将它们汇总为一个 Claude Code 客户端状态。

## 多桌宠分配

- Claude Code 开始工作时，从启用工作状态联动的空闲桌宠中动态随机挑一只；工作期间保持该分配，结束后释放，下次工作可以选到另一只。
- 多个客户端同时工作时各自占用不同的空闲桌宠；可用桌宠不足时，未分配的客户端等待空位释放。
- 完成/错误状态保留 10 秒，让桌宠播放结束动画后释放；异常退出且没有结束事件时，活跃状态最多保留 10 分钟。

## 数据与隐私

桥接文件默认位于 `<DSH_HOME>/dsh-pet/claude-code-work-status-bridge.json`，`DSH_HOME` 缺省为 `~/.dsh`。可使用 `CLAUDE_CODE_PET_BRIDGE_PATH` 指定完整路径。插件每秒刷新桥接时间戳，以满足桌宠的状态新鲜度窗口。

插件会从 Hook 输入读取事件名、session ID、agent ID，以及状态映射所需的 `source` / `notification_type` / `transcript_path`。监听器在本机增量读取会话记录，并在内存中识别中断标记；不保存或上传提示词、对话正文。桥接文件仅保存 session/agent ID 的哈希、状态和时间戳；并发 Hook 与心跳更新使用文件锁，避免同时写入时覆盖彼此的状态。

诊断日志写入 `CLAUDE_PLUGIN_DATA` 下的 `bridge.log`；若环境变量缺失，则写入 `<DSH_HOME>/dsh-pet/dsh-pet-work-status-bridge-claude-code/bridge.log`。日志记录事件名、状态及错误代码，不记录 Hook 输入或异常消息内容。

## 安装

前提：DSH Pet 独立版已运行并开启「工作状态联动」，本机可从命令行执行 `node`。

仓库内插件目录为 `dsh-pet/claude-code-pet-work-status-bridge/`，Hook 配置位于 `hooks/hooks.json`。插件版本为 `0.2.11`。安装或更新后，在 Claude Code 中重新加载插件；若客户端提示审核 hooks，请检查并确认信任。

如需直接配置到用户级 `settings.json`，可把完整事件配置从 `hooks/hooks.json` 合并进去；不要覆盖文件中已有的其它 hooks。

## 限制

- 仅 DSH Pet 独立版宿主读取该桥接文件；DSH 内嵌模式不读取此文件。
- 插件仅同步 Claude Code 工作状态，不发送系统通知；DSH 通知由 DSH 工作流桥接提供。
- 子代理状态依赖 Claude Code 提供的 `agent_id`；若 Hook 输入缺少该字段，该事件会归属到主 Agent。
