# Codex Pocket：产品与架构约束

## 产品目标

Codex Pocket 是 Codex 的移动端 WebUI / PWA，用于从手机等移动设备浏览和管理运行在 Pocket 主机上的 Codex CLI 会话，并与 Codex Desktop 协作；它不是另一套独立会话系统。产品优先级依次是：

1. 会话不能因为刷新、目录同步延迟或首条消息失败而消失。
2. 不抢占 Desktop / CLI 的 writer；发生冲突必须由用户确认后 fork。
3. 一个会话的工作、审批或故障不能阻塞其他会话释放 writer。
4. 项目、普通会话、顺序、权限、模型和状态尽量与 Desktop 保持同一语义。
5. 手机弱网下先显示可用内容，再异步刷新；后台页面不做高频轮询。

### Desktop、CLI 与 Pocket 的协作边界

- Pocket 服务运行在拥有目标 Codex 用户状态和工作区的主机上；移动浏览器是远程 UI，不直接访问本机文件或 App Server。
- Codex CLI / App Server 提供 Pocket 的会话操作能力。Pocket 与 Desktop 可并行使用同一用户的会话；Desktop 进程不是 Pocket 的依赖，也不会被 Pocket 启动、停止或控制。
- Desktop catalog 和私有全局状态只作为只读展示 / 项目 metadata 来源。Pocket 不回写 Desktop 私有全局状态文件。
- 同一会话被 Desktop、CLI 或其他 writer 占用时，Pocket 不抢占；只有用户确认后才 fork 副本继续。
- 产品定位不限定 macOS。运行平台需能运行受支持的 Codex CLI，并提供所需的子进程、文件、SQLite 和持久存储能力；进程托管、路径和网络入口由具体部署适配。本文后续明确标为“当前生产实例”的配置是 macOS + Tailscale。

## 状态权威

| 数据 | 权威来源 | 补充来源 |
| --- | --- | --- |
| 会话是否存在、归档、rollout、时间 | `~/.codex/state_5.sqlite` | fork / start 响应的 10 分钟 read-after-write overlay |
| Desktop 展示标题、标准化 source | `local_thread_catalog` | state 中的 name / title / preview |
| Desktop 项目、顺序、显式归属、普通会话、置顶、权限 | `.codex-global-state.json`（只读） | state sandbox / approval 字段 |
| Pocket 新建/fork 的项目归属与权限覆盖 | `~/.codex/codex-pocket-state.json` | Desktop 后续显式项目选择优先 |
| Pocket 活跃回合、审批、writer 租约 | 每会话 runtime worker | rollout 生命周期用于观察其他客户端状态 |
| 写请求去重与结果 | `~/.codex/codex-pocket-requests.sqlite`（Pocket 独占） | 浏览器持久请求编号与待确认状态 |
| 草稿与阅读位置 | 浏览器按 thread id 存储 | 页面内存用于存储不可用时保留输入 |
| 当前打开的会话 | URL `?thread=<id>` | 浏览器短期 ThreadStore |

关键规则：Desktop catalog 是可延迟的展示投影，不能决定会话 membership。state-only 的用户 fork 必须显示；subagent 和内部 source 必须过滤。

Pocket 不改写 Desktop 的私有全局状态文件，避免两个进程同时保存时发生整文件覆盖。Pocket 自己创建的会话和权限选择写入独占 sidecar；若 Desktop 后续对同一会话做出显式项目归属或 projectless 选择，以 Desktop 为准。

## 运行时边界

```text
HTTP / SSE Gateway
├─ Catalog: SQLite + Desktop state（只读）+ Pocket sidecar
├─ Control App Server
│  └─ thread/read, thread/list fallback, model/list, config/read
└─ ThreadRuntimePool
   ├─ thread A worker → active / approval / idle lease
   ├─ thread B worker → active / approval / idle lease
   └─ transient worker → thread/start 或 thread/fork，得到 id 后绑定
```

控制进程不 resume 会话，因此不持有 writer。每个 worker 最多拥有一个 Pocket 会话。回合完成或仅创建未发送时进入 `IDLE`，3 分钟无新写操作后停止进程并释放 writer；活跃回合或待审批状态没有释放 deadline。

CLI 0.154.0 的新建 `paginated` 会话存在初始化窗口：writer 的 `thread/read(includeTurns: true)` 可能返回 `-32601: list_turns is not supported yet`。此时从同一 writer 只读会话摘要以保留模型和思考深度，再由控制进程读取已存储的完整轮次。不能直接把该错误当成空历史，也不能因 `thread not loaded` 创建 worker 或 resume 会话；读取失败应保留真实错误。

多 App Server 的审批 request id 可能重复，因此 Web API 使用带 runtime 前缀的唯一 id 路由响应。worker 退出时，其未决审批必须全部从前端清除。

## 部署与网络边界

通用部署边界：Pocket 网关应只绑定 loopback，由受信任的私密 HTTPS 入口代理；不能仅因 WebUI 没有独立登录页而直接暴露服务。生产环境还需以 tailnet / VPN / 等效身份与访问控制限制可访问设备。具体进程托管和入口产品取决于部署平台。

### 当前生产实例：macOS + Tailscale

当前部署示例使用 macOS 用户级 LaunchAgent 托管服务，并通过服务的 `PATH` 查找独立安装的 Codex CLI；不使用 Codex Desktop 应用包内的 CLI。因此 Desktop 退出不会影响 Pocket；Pocket 的控制进程和每会话 worker 都由独立 CLI 提供。

HTTP 网关只允许监听 `127.0.0.1:3210`。Tailscale Serve 在 Tailnet 接口的 3210 端口处理 HTTPS，终止 TLS 后代理到本机 HTTP 服务：

```text
Tailnet https://<machine>.<tailnet>.ts.net:3210
        │ Tailscale HTTPS 3210（tailnet only，TLS 终止）
        ▼
http://127.0.0.1:3210
```

不得监听 `0.0.0.0`、局域网 IP，不得配置 Funnel、路由器端口转发、公共反向代理或额外的 80/443 映射。MagicDNS 负责域名解析，Tailscale Serve 管理完整 `.ts.net` 域名对应的 HTTPS 证书；两项功能均需在 Tailnet 后台启用。普通局域网设备无法通过 Pocket 主机的 LAN IP 访问 3210。

当前实例使用 HTTPS 代理；HTTPS 使浏览器可以启用 Service Worker 和离线页面壳，实际会话操作仍需 Pocket 主机与 Tailscale 在线。不同 origin 的浏览器缓存与本地设置不会自动迁移，已有主屏幕入口应使用实际部署地址重新添加。

这是当前 macOS 部署的用户级而非系统级服务：Mac 重启后需要用户登录；Mac 睡眠、退出用户登录或 Tailscale 离线都会使手机端不可达。其他平台部署应为 Pocket 主机配置等效的可靠进程托管和私密网络入口。

## fork 的恢复语义

fork 是两阶段操作：

1. `thread/fork` 成功并返回持久 thread id。
2. 在新 thread 上执行 `turn/start`。

第一阶段成功后，服务端立即登记副本并返回该 id。第二阶段失败时响应包含 `sendError`，客户端仍导航到副本，保留原输入供重试。请求带 `clientRequestId`，去重结果持久保存在 Pocket 请求日志，网络重试和进程重启后查询不会重复创建副本。

前端拿到新 id 后必须先 optimistic upsert、写入 URL 并打开副本，再后台刷新 canonical list。任何列表响应都不能删除当前或近期创建但尚未被目录确认的会话。

## 手机端恢复与写请求

新客户端的新建、发送、steer 与 fork 请求均带独立 `clientRequestId`。请求日志先持久登记 `pending`，执行完成后记录 `confirmed` 和返回值，明确拒绝记录 `failed`。相同编号与不同内容返回冲突。请求编号和结果不随网关重启清空；只读 `GET /api/requests/:id` 不创建 worker。

进程启动时将遗留 `pending` 标为 `unknown`。传输错误和无法确定结果的 RPC 错误同样保持 `unknown`，不会推断操作未执行，更不会自动重发。前端超时后先查询结果；只有明确不存在的编号才可由用户重试原请求。日志保留请求指纹而非原始输入，已确认结果仍可能包含会话内容，文件权限为当前用户读写。旧客户端不带编号的请求继续兼容，但不具有持久去重保障。

前端按会话保存草稿和修订号，只有确认响应对应的修订仍是当前草稿时才清空；切换会话和请求返回不会互相覆盖输入。阅读位置用消息 id 和相对偏移恢复。同步失败保留已显示的内容并提供重试；仅在看到底部时标记当前会话的完成活动已读。长会话先展示最近 100 条，按需加载更早消息，并保证已保存的阅读锚点可见。

## 不变量

- `GET /api/threads` 中同一 id 最多出现一次。
- 非归档用户 fork 在 state 落盘后立即可列出；重建进程后仍可列出。
- `thread_source=subagent`、JSON subagent source 和非交互内部 source 不进入用户列表。
- 只读 list / read / model 请求不会创建 thread worker。
- 同一 thread 的写操作串行化，不会并发 spawn 两个 writer。
- A thread 等待审批时，B thread 完成后的租约仍能独立到期。
- fork 已成功但发送失败时，调用方仍拿到新 thread id。
- 页面刷新、深链、前进和后退均由 URL 恢复同一 thread。
- 同一请求编号的重试不重复执行；服务重启后未知结果不被自动重放。
- 发送确认不清除更新版本或其他会话的草稿；重新同步不把正在阅读历史的用户强制滚到底部。

## 验证门槛

每次上线前必须完成：

- `npm run check`：所有服务端、运行时和浏览器模块语法检查。
- `npm test`：目录合并、state-only fork、subagent 过滤、权限、运行时隔离、审批路由、租约、ThreadStore 和 HTTP 集成。
- `npm run test:browser`：手机视口 E2E，覆盖草稿与发送竞态、丢失响应、未知请求、原编号重试、阅读位置与缓存失败、writer 冲突确认、fork、刷新恢复、URL 前进 / 后退、模型和思考深度，以及模拟 App Server 的 SSE / 审批 / 停止；图片上传失败与恢复、切换草稿、纯图片发送、差异安全显示、待处理筛选、运行诊断与单独释放。
- 当前生产实例 smoke test：LaunchAgent、本机与部署 HTTPS 地址的 `/api/status`、HTTPS 证书、SSE、浏览器 Service Worker、普通 LAN IP:3210 不可达、静态资源压缩和日志无新增错误。其他部署需针对其进程托管与私密入口执行等效检查。

只有以上检查通过后才能重启当前生产实例的正式 LaunchAgent。

## 图片、结果查看与运行诊断

- 图片通过受同源检查保护的 `POST /api/images` 上传，仅接收 PNG / JPEG / WebP 文件签名，单张 10 MB、单消息 4 张；SHA-256 文件名防止路径注入并使上传重试去重，目录 0700、文件 0600。消息 API 只接收已存在的图片 ID，由网关转换为 App Server `localImage` 输入，不接收客户端路径。
- 浏览器 IndexedDB 保留待发送图片的字节与 MIME 类型（读取时还原为 Blob，兼容 WebKit），草稿保留图片引用和状态；上传及发送完成只修改对应 thread 和草稿 revision。重载可恢复上传重试，纯图片发送、steer 和显式 fork 使用相同输入格式。图片不自动清理；仅允许通过引用台账清理已移除超过 24 小时、从未用于发送的图片。未知引用和历史图片永久保护。
- 文件修改保留 App Server 的 diff，逐文件展开并通过 `textContent` 显示增删行。每个文件最多 40,000 字符、每条修改总计 200,000 字符；命令显示退出码、耗时与末尾 20,000 字符输出，截断必须可见。
- 待处理筛选包含等待审批/问题、未读完成、错误状态与待核对请求。运行诊断读取 `/api/status`，按会话显示独立 worker 和截止时间。`POST /api/threads/:id/release` 与同会话写入串行，仅释放 Pocket 空闲 worker，运行中或有审批时拒绝，未加载会话保持未加载。
- `lib/static-assets.mjs` 在启动时生成完整静态快照及内容指纹；`__BUILD__` 同时替换 HTML、模块、SW 和 session cache，SW 预缓存自动收集 public 资源。所有模块变更均改变版本；匹配指纹的资源可长期缓存，未带正确版本的请求不能设置 immutable。

## 后续路线

- P1：任意文件附件输入；在上游支持后进一步避免完整历史读取。
- P2：若 App Server 未来提供显式 writer handoff / lease API，替换进程级释放策略。
- P2：可选的 tailnet 身份授权；单用户环境继续保持无二次登录。

## 分页、重连与安全更新

`GET /api/threads/:id?limit=100` 默认读取尾页，`before` / `after` 使用稳定的 turn + item 游标，`around` 按阅读锚点定位，最大 200 条。缺失的翻页游标报 409；恢复阅读时锚点消失会回退到最新。旧客户端未传 limit 时保持完整响应。分页响应和 SSE 文件变更仅给出摘要，展开后通过只读 diff API 获取截断后的差异。各只读路径都不获取 writer；上游仍可能完整读取历史，网关压缩缓存最多 20 个会话且总计不超过 24 MB。

浏览器将前后页合并为最多 200 条的窗口；阅读旧窗口时新事件只设置有后续消息，不挤走当前阅读位置。恢复页面会按锚点请求窗口。事件流超过 55 秒无字节则终止并退避重连，心跳注释也续期；隐藏和断网时停止连接，恢复时重新查询会话、写请求结果及诊断，不重放写入。

SW 安装后等待显式更新，不自动 skipWaiting；更新时通过 MessageChannel 向所有页面确认草稿保存与忙碌状态，无响应按忙碌处理。页面上传、发送、附件写入本地存储期间以及有未落盘草稿时均禁止刷新。更新不删除旧页面所用资源，离线 HTML 与预缓存版本保持一致。手动清缓存保留运行中各页面的版本，等待安装 / 激活时拒绝清理。

## 推送与存储台账

- 通知使用独立 `~/.codex/codex-pocket-notifications.sqlite`（0600），持久保存 VAPID 密钥、订阅、完成活动观察位置及投递去重记录。测试使用内存库或隔离目录和模拟 sender。
- 默认没有订阅，不会发起推送。开启必须由用户点击并授权系统权限。仅接受 Apple、FCM、Mozilla 的已知 HTTPS 推送域名和合法密钥长度，拒绝任意内网 URL。订阅接口受同源检查保护，不修改入口监听或 Tailscale 暴露面。
- 通知正文仅使用通用模板；Pocket 完成 / 失败 / 审批事件触发投递，15 秒轮询本地完成活动补充 Desktop / CLI 完成通知。只投递订阅后近期的新活动。超时与服务错误有限重试，404 / 410 清除失效订阅，积压超过 30 分钟不补发。
- Web Push 外部投递无法提供严格 exactly-once；本地去重和固定 notification tag 减少重复展示。它与永不自动重放的会话写请求日志相互独立。
- 图片目录 `index.sqlite` 保存上传引用和是否用于发送。发送前在同一串行队列里永久标记 used；清理也在该队列中重新核对资格。历史文件、旧客户端和无法确认是否发送的文件不进入清理范围。断网导致引用移除失败时保守保留，不猜测它已废弃。
- 存储诊断展示图片、请求数据库逻辑大小、历史缓存、日志及浏览器估计值。浏览器清理仅删除可重新加载的 session history 和闲置版本资源，绝不删除草稿、待核对操作和附件字节。

## WebKit 验证边界

Chrome 与 WebKit 均运行 iPhone 视口测试。WebKit 的自动化断网开关在本机使导航在 SW 接管前报内部错误，因此离线壳测试使用仅监听 127.0.0.1 的临时代理实际断开所有套接字；Chrome 同时测试断网开关。测试代理只存在于测试进程，结束即关闭。真正的 iPhone 主屏幕安装、系统通知、键盘与锁屏后台行为仍需实机验收。
