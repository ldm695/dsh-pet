# dsh-pet-work-status-bridge（Codex 版）

这是一个 Codex 插件，将 Codex 的工作状态同步到 DSH Pet 独立版。它通过 Codex lifecycle hooks 写入桌宠已有的桥接文件协议，不保存提示词、对话正文、工具参数或工作区文件。桌宠端按客户端来源分配：Codex 的所有根对话（包括侧边对话）和子代理合并为一个 Codex 工作状态，只占一只桌宠；Claude Code、DSH 各自也最多占一只。不同客户端来源之间仍分别分配桌宠。

## 状态映射

| Codex 事件          | 桌宠状态        |
| ------------------- | --------------- |
| 用户提交消息        | 思考 `thinking` |
| 工具开始            | 工作 `working`  |
| 工具结束            | 整理 `result`   |
| 子代理开始/工作中   | 工作 `working`  |
| 子代理结束          | 完成 `success`  |
| Codex 请求工具权限  | 等待 `waiting`  |
| Codex 回合结束      | 完成 `success`  |
| 中断或会话开始/结束 | 空闲            |

插件会启动一个本地心跳进程，在 Codex 生成期间每秒刷新桥接时间戳，以匹配桌宠的状态过期窗口。桥接文件分别维护根 Agent 和子代理；桌宠端再将同一客户端报告的状态聚合到一个槽位，因此侧边对话、并行会话和子代理不会额外占用桌宠。聚合时优先显示仍在进行的任务，再取该客户端最近活动的状态。完成状态保留 10 秒后自动清空；收到 `Interrupt` 后会清除该会话，并忽略该会话此后到达的迟到事件，直到用户提交新消息，避免旧工具结果、子代理或结束事件重新建立状态。异常退出且没有结束事件时，活动状态最多保留 10 分钟。插件版本为 `0.2.5`。插件不保存历史记录。桥接文件只保存会话、回合和子代理标识的哈希值，不保存原始标识。状态变化与桥接故障会写入诊断日志，日志不包含提示词、对话正文、工具参数、原始会话标识或工作区路径。

桥接文件默认位于 `%USERPROFILE%\.dsh\dsh-pet\codex-work-status-bridge.json`，与 DSH 桥接文件分开保存。若 DSH 使用自定义目录，可为 Codex 进程设置 `DSH_HOME`；也可通过 `CODEX_PET_BRIDGE_PATH` 指定完整文件路径。Codex 插件 hooks 需要在插件安装后由用户审核并信任。

## 本地安装

先克隆本仓库，并在 Codex CLI 中把仓库根目录添加为本地 marketplace：

```powershell
git clone https://github.com/ldm695/dsh-pet.git
Set-Location .\dsh-pet
codex plugin marketplace add (Get-Location).Path
```

添加后，可通过 `codex plugin marketplace list` 查看本地 marketplace ID，再安装或更新插件：

```powershell
$marketplaceId = '替换为上一步显示的本地 marketplace ID'
codex plugin add "dsh-pet-work-status-bridge@$marketplaceId"
```

也可以在 Codex 桌面端的插件目录中，从「DSH Pet 本地插件」安装或更新 `dsh-pet-work-status-bridge`。安装后在插件设置中审核并信任 hooks，再重启 Codex。重启后在 CLI 中打开 `/hooks`，确认 `SessionStart`、`UserPromptSubmit` 等事件已安装并启用。

启用 DSH Pet 独立版设置中的「工作状态联动」后即可观察状态。每个客户端来源最多占用一只桌宠：同一 Codex 客户端的根会话、侧边对话和并行子代理共享一只桌宠；Claude Code 和 DSH 各自使用独立槽位。插件不读取 Codex 界面，也不需要判断哪个对话位于主视图或侧边视图。

## 隐私与限制

- Hook 事件输入中可能带有 prompt、工具名、session ID 和子代理 ID；桥接程序仅读取事件名、状态所需的标识字段，不序列化 prompt、工具参数或其它输入字段。
- 桥接文件含状态、时间戳、递增版本号、来源和用于分配的哈希键；不含原始会话/子代理标识或对话内容。
- 插件 hooks 需用户明确审核并信任；禁用或未信任 hooks 时不会联动。
- 诊断日志位于 Codex 提供的 `PLUGIN_DATA` 目录下 `bridge.log`；若该变量缺失，则回退到 `%USERPROFILE%\\.dsh\\dsh-pet\\dsh-pet-work-status-bridge-codex\\bridge.log`。日志中出现 `bridge=written` 表示钩子已执行并写入状态；若日志不存在，通常表示插件未启用、hooks 未获信任，或 Codex 尚未触发钩子。
- 通知转发尚未实现；此版本只同步动画工作状态。
- 若 Codex 所在环境没有可从命令行启动的 Node.js，hooks 无法运行。
