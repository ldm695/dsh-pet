# DSH Pet HTTP API 概览

DSH Pet Windows 应用在本机 HTTP 服务上提供统一的 `/dsh-pet-7340` 路由前缀，供桌面 Helper、内嵌设置页和本机集成使用。DSH Pet 不再注册为 DSH Web 插件，也不会向 DSH Web 页面显示桌宠。本文提供接口概览；参数、响应结构、字段定义、错误码和示例请参阅根目录的 [`openapi.yaml`](openapi.yaml)。

- **基址**：`http://127.0.0.1:6952/dsh-pet-7340`（默认端口；被占用时应用会顺延）
- **只监听 127.0.0.1，且没有鉴权**：任何能访问本机该端口的进程都能调用，请勿转发到公网

---

## 状态查询

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/state` | **轮询唯一数据源**：所有状态位都在这里；带 `?since=&timeout=` 可长轮询 |
| `GET /dsh-pet-7340/config` | 读合并后的成品配置（内置默认 + 用户层，字段已填满） |
| `GET /dsh-pet-7340/config/meta` | 配置文件路径、各类数据落盘位置、卸载该用哪个 profile |
| `GET /dsh-pet-7340/models` | 可用服务商与模型清单（与 DSH 自己的模型选择器同源） |
| `GET /dsh-pet-7340/chat?pet=` | 读某只桌宠最近的对话记忆窗口 |

## 操作

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/whisper?pet=&surface=desktop` | 让桌宠**生成**一句碎碎念（走当前模型） |
| `POST /dsh-pet-7340/broadcast?pet=&surface=desktop` | **第三方投喂**：把文本及可选远程配图写进气泡（不生成，只搬运） |
| `POST /dsh-pet-7340/bubble/clear?pet=&surface=desktop` | **清空气泡**：提前收起说话气泡（只动气泡，不动动画） |
| `POST /dsh-pet-7340/anim?pet=&surface=desktop` | **点播动画**：播放池内动画或远程视频，可选指定朝向；回 `playbackId` |
| `GET /dsh-pet-7340/playback/{id}` | **播放回执**：查那次点播的真实状态；带 `?wait=&timeout=` 可挂起等待 |
| `POST /dsh-pet-7340/playback/{id}/report` | 渲染端上报播放状态（**内部通道**，第三方不用调） |
| `POST /dsh-pet-7340/chat?pet=&surface=desktop` | 对桌宠说一句话并生成回复，同时写入对话记忆 |
| `POST /dsh-pet-7340/position?pet=&surface=desktop` | **位置控制**：挪到归一化坐标，`mode` = 直接/弹簧/直线；不碰动画 |
| `POST /dsh-pet-7340/throw?pet=&surface=desktop` | **原生抛掷**：给桌宠一个初速度让它飞出去（`angle` 度、`power` 倍率） |
| `POST /dsh-pet-7340/lock?pet=&surface=desktop` | 申请或续期单只桌宠的独占控制租约 |
| `POST /dsh-pet-7340/lock/release?pet=` | 释放租约；用户接管时可强制释放 |
| `POST /dsh-pet-7340/balance` | 立即刷新一次余额 |
| `POST /dsh-pet-7340/reload` | 重载桌面端（重启桌面宠物进程，按最新配置重建窗口） |

## 配置管理

| 接口 | 功能 |
| --- | --- |
| `PUT /dsh-pet-7340/config` | 保存用户层配置（白名单重建，用户手写的精调字段会保留） |
| `POST /dsh-pet-7340/pet-display` | **改单只宠物的显示位置**（`desktop` / `none`），只传 `{ id, display }` |
| `POST /dsh-pet-7340/config` | 用内置默认整份覆盖用户配置，即「恢复默认」 |

## 静态资源

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/thumb/{petId}/{file}` | 动画素材（`.webm` / `.mov`，按宠物归属） |
| `GET /dsh-pet-7340/font/{file}` | 字体文件 |
| `GET /dsh-pet-7340/pic/{file}` | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属） |

---

## 接口约定

1. **目标必须明确**：动作接口要求显式提供存在的 `pet`。会产生桌面视觉效果的接口还要求
   `surface=desktop`；缺少参数或目标桌宠处于隐藏状态时会返回 `ok:false`，不会静默落到列表中的另一只宠物。
2. **独占控制**：多数动画、气泡和移动动作在桌宠被锁定时需要携带返回的 `lockId`；否则会收到
   `lock-required`。锁有时限，调用方可用同一 `lockId` 续期；用户点击或拖动桌宠可以接管并释放锁。
3. **数据只有一个出口**：`GET /state`。它返回宿主内存里的已发布状态，每个状态位是
   `{ counter, data }`。
4. **动作端点不返回数据**：大多数 `POST` 只回 `{ ok: true }`；结果写进状态，
   长轮询那一拍会立刻把它送到（调用方不必主动补拉）。
   **两个例外**，都只多回"受理"层面的信息：
   - `POST /anim` 额外带回 `playbackId`——只代表"受理了"，**不等于播完了**；
     真实回执看 `GET /playback/{id}`。
   - `POST /position` 额外带回夹取后的 `x`/`y`（越界会被夹到 `0~1`，回的是实际生效值）。
3. **`counter` 变了才渲染**：它是 `Date.now()` 且严格递增，宿主重启也不会倒退。
   状态位的路径（如 `sections.balance`、`pets.<id>.say`）请当作**不透明键**使用——
   宠物 id 允许含点号，**不要按 `.` 切分**。

## 请求示例

```bash
BASE=http://127.0.0.1:<port>/dsh-pet-7340

# 拉一次状态（只读、零副作用，可以随便轮询）
curl -s $BASE/state

# 长轮询：带上上一拍拿到的 counter —— 叶子一变立刻返回，最多挂 1 秒
curl -s "$BASE/state?since=1755000000007&timeout=1000"

# 让桌宠说一句外部给的话，然后立刻回读状态
curl -s -X POST "$BASE/broadcast?pet=main&surface=desktop" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕，一切正常"}'
curl -s $BASE/state   # → pets.main.say.data.text

# 只弹 3 秒气泡、不播说话动画
curl -s -X POST "$BASE/broadcast?pet=main&surface=desktop" \
     -H 'content-type: application/json' \
     -d '{"text":"该喝水了","duration":3000,"anim":false}'

# 提前收起气泡（正在播的动画不受影响）
curl -s -X POST "$BASE/bubble/clear?pet=main&surface=desktop"

# 让它播一段动画（名字取自 GET /config 里**该宠物所属条目**的 animations：
#  main 条目的宠物用 main 的池，pet/<名>-config.json 的种类各用自己的池）
curl -s -X POST "$BASE/anim?pet=main&surface=desktop" \
     -H 'content-type: application/json' \
     -d '{"name":"东张西望"}'
```

## 独立模式

不启动 DSH 时，同一组 `/dsh-pet-7340` 接口由本机 HTTP 服务提供（`src/standalone/server.ts`，用法见 [`dsh-pet/README.md`](dsh-pet/README.md) 的独立运行章节）：

```bash
BASE=http://127.0.0.1:6952/dsh-pet-7340   # 默认端口；被占用时自动向后顺延
```

独立模式将插件的宿主部分运行在独立上下文中，并复用 `src/host/index.ts` 的路由实现。桌面助手仍通过 bridge 管道通信。因此，本文件与 [`openapi.yaml`](openapi.yaml) 所描述的 `/dsh-pet-7340` 契约在两种运行方式下保持一致。

独立模式另外多两个只属于该服务的运维端点（不在 `/dsh-pet-7340` 前缀下，故不在 OpenAPI 契约里）：

| 端点 | 说明 |
| --- | --- |
| `GET /`、`GET /health` | 服务与插件信息：名称、插件根与版本、监听端口、已运行秒数 |
| `POST /shutdown` | 优雅停机：释放插件注册的 effect（停止桌面助手、清掉周期定时器）后关闭服务，进程退出码 0 |

依赖 DSH 的能力在独立模式下不可用，并以结构化结果返回：`POST /whisper`、`POST /chat`
回 `{ ok: false, reason: 'provider-missing' }`（没有模型服务），`POST /balance` 回
`{ ok: false, reason: 'unsupported' }`，`GET /state` 的各状态位保持空闲初始值。

## 相关

- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
