# 安装与构建说明

本文介绍如何使用本仓库维护的 DSH Pet 版本，包括 Windows x64 独立应用和 DSH 插件。直接安装标准 `dsh-pet` npm 包时，获得的可能是上游版本，不一定包含本仓库的改动。

## Windows 独立桌面应用

独立版无需启动 DSH，通过 Electron 透明桌面窗口显示桌宠，不会将桌宠注入浏览器页面。

### 使用已发布的版本

如仓库的 [Releases](https://github.com/ldm695/dsh-pet/releases) 中提供 Windows x64 版本，可下载 Portable 可执行文件直接运行，无需安装向导。启动后，在桌宠右键菜单中选择「打开桌宠设置」进行配置。

### 从源码构建

需要 Windows x64、Git、Node.js `22.12.0` 或更高版本，以及 pnpm 11。

在 PowerShell 中执行：

```powershell
git clone https://github.com/ldm695/dsh-pet.git
Set-Location .\dsh-pet\dsh-pet
pnpm install --frozen-lockfile
pnpm run build:exe:public
```

Portable 可执行文件生成在 `dsh-pet\portable-dist\DSH-Pet-0.3.7-portable.exe`。文件名中的版本号会随包版本变化。

### 首次启动与数据位置

应用启动后桌宠直接显示在桌面上，不会自动打开设置窗口。可通过桌宠右键菜单进入设置。若需使用对话、碎碎念或余额查询，请配置 DeepSeek API Key。Windows 下，设置页面保存的密钥使用当前用户的 DPAPI 加密；也可以通过环境变量 `DSH_PET_STANDALONE_DEEPSEEK_API_KEY` 提供密钥，环境变量优先于已保存的密钥。

默认配置和用户数据保存在 `%USERPROFILE%\.dsh\dsh-pet\`。若设置了 `DSH_HOME`，数据根目录将由该变量决定。

## 将本仓库版本安装为 DSH 插件

从源码构建并通过本地路径安装，可确保安装的是本仓库版本，而不是上游 npm 包。

```powershell
git clone https://github.com/ldm695/dsh-pet.git
Set-Location .\dsh-pet\dsh-pet
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile desktop add "file:D:/path/to/dsh-pet/dsh-pet"
```

将最后一行中的路径替换为克隆后插件包目录的绝对路径。若使用 `dsh web`，将 `--profile desktop` 替换为 `--profile web`。安装后重启对应的 DSH 进程。DSH 桌面应用也可通过应用内的插件管理页面安装本地目录。

浏览器显示需要 DSH Web 正在运行且已加载插件。将宠物的 `display` 设置为 `web` 或 `both` 即可在浏览器中显示。独立可执行文件不会检测或注入 DSH 页面。

## 可选的工作状态联动

工作状态桥接插件独立于桌宠应用，需要按需安装，并在 DSH Pet 设置中启用「工作状态联动」：

- [DSH 桥接插件](dsh-pet/dsh-pet-work-status-bridge/README.md)
- [Codex 桥接插件](dsh-pet/codex-pet-work-status-bridge/README.md)
- [Claude Code 桥接插件](dsh-pet/claude-code-pet-work-status-bridge/README.md)

Codex 和 Claude Code 插件需要在对应客户端审核并信任生命周期钩子。同一客户端的多个会话和 Agent 会合并为一个工作状态，同时最多占用一只桌宠；不同客户端来源可分别分配空闲桌宠，桌宠不足时未分配的客户端等待空位。

## 平台范围

本仓库构建的独立可执行文件面向 Windows x64。上游插件的兼容性说明不代表本 Fork 的独立版已支持 Linux 或 macOS。上游插件平台信息请参阅[兼容性文档](https://github.com/PC2005-cloud/dsh-pet#兼容性)。
