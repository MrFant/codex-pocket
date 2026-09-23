# Codex Pocket

Codex Pocket 是面向手机等移动设备的 Codex 响应式 WebUI / PWA。它连接运行在 Pocket 主机上的 Codex CLI，通过 Codex App Server 浏览和管理该用户的 Codex 会话，并与 Codex Desktop 协作；它不是另一套独立会话系统。

Pocket 与 Desktop / CLI 面向同一主机、同一 Codex 用户的数据协作。Desktop 可以同时运行，但不是 Pocket 的运行依赖；Pocket 通过 Codex state 和只读的 Desktop metadata 对齐会话与项目视图，实际会话操作由独立 Codex CLI / App Server 执行。若其他客户端正在写入同一会话，Pocket 不会抢占，而会要求用户确认后再 fork 副本继续。

产品不限定运行在 macOS。Pocket 服务部署在能够运行受支持 Codex CLI、并访问对应用户会话状态和工作区的主机上；手机浏览器通过私密 HTTPS 入口访问。本文中的 macOS、LaunchAgent、Tailscale 主机名和绝对路径描述的是当前生产部署实例，不代表产品只能运行在 Mac。

> 这是非官方、自托管方案。Pocket 具有对应 Codex CLI 用户可用的文件与命令权限，请仅通过 tailnet、VPN 等私有网络和访问控制使用，不要公开暴露。

## 架构

```text
手机 / 平板浏览器（PWA）
   │ 私密 HTTPS 入口（当前生产部署使用 Tailscale Serve）
私密反向代理 / 入口（TLS 终止）
   │ http://127.0.0.1:3210
Pocket 主机上的 Codex Pocket（Node 网关）
   ├─ 本地统一会话目录（Codex state + Desktop metadata）
   ├─ 只读控制 App Server（列表 / 读取 / 模型）
   └─ 每个活跃会话独立的 App Server worker（写入 / 审批 / 3 分钟租约）
      │ stdio JSON-RPC
该用户的 Codex CLI 会话和工作区
```

网关默认只监听 `127.0.0.1`，浏览器不会直接连接 App Server。入口应保持私有并提供 HTTPS；当前生产部署只允许 Tailnet 内访问。当前功能包括：

- 浏览、搜索和读取 Pocket 主机上该用户的 Codex 会话（含已归档筛选）
- 继续会话并实时接收回复
- 选择或粘贴截图，预览、移除、上传重试，支持图片草稿恢复及纯图片发送
- 按文件展开时再读取差异，显示增删行、命令退出码和耗时
- 一键筛选等待确认、未读完成和异常会话
- 点击右上角连接状态查看运行诊断；空闲会话显示独立倒计时并可主动释放
- 静态资源内容指纹自动关联页面、模块、离线缓存和会话缓存；新版本就绪后显式保存并刷新，上传或发送中会暂缓
- 事件流心跳超时自动重连，锁屏返回或网络恢复后重新核对状态
- 可选的完成 / 失败 / 等待确认通知，默认关闭，在「运行诊断 → 通知与存储」按设备开启
- 查看服务器和浏览器存储占用，预览并清理已移除超过 24 小时且从未发送的图片，保留历史附件与请求记录
- 按会话保存草稿，刷新后恢复；发送确认不会清除随后输入的新内容
- 新建、发送、steer 和 fork 使用持久请求记录，断网后可核对结果，未知结果不会自动重发
- 保留阅读位置，刷新失败继续展示现有消息；长对话由 HTTP API 按 100 条分页，浏览器最多保留 200 条的阅读窗口，并提供前后翻页和跳到最新入口
- fork / 新建会话立即进入统一目录，刷新、重启页面或深链打开都不会丢失入口
- 对话完成后空闲 3 分钟，独立停止该会话的 worker 并释放 writer
- 会话列表和对话标题实时显示空闲、正在处理、等待确认或异常状态
- 项目名称、顺序、显式归属、普通会话和置顶状态跟随 Codex Desktop
- Pocket 自己的新建/fork 项目归属与权限保存在独占 sidecar，不改写 Desktop 私有状态文件
- 再次操作时自动启动 App Server，并 resume 同一个任务
- 原任务被其他客户端占用时，经确认后创建副本继续；副本创建和首条消息发送可分别恢复
- 在进行中的回合里 steer（追加要求）或停止
- 按任务明确显示并选择实际使用的模型和思考深度
- 在手机上处理命令和文件修改审批
- PWA 安装、离线壳、移动端布局
- URL 深链、刷新恢复和浏览器前进 / 后退
- 同源检查和安全响应头

内部 reasoning 不会显示在 WebUI 中。

## 要求

- Node.js 22 或更新版本
- 在 Pocket 主机上安装并登录受支持的 Codex CLI，且 `codex app-server` 可运行
- Pocket 运行用户能够访问该 Codex 用户的会话状态和工作区
- 手机 / 平板使用支持现代 JavaScript、Service Worker 的浏览器
- 配置仅授权用户可访问的私密网络入口；当前生产部署使用 Tailscale，并要求服务主机和移动设备加入同一 tailnet

## 本机启动

在 Pocket 项目目录执行：

```bash
npm start
```

默认地址是 `http://127.0.0.1:3210`。应用不提供独立登录页，应通过本机回环地址或经过妥善访问控制的私密 HTTPS 入口访问；不要直接暴露到互联网或普通局域网。

开发与检查命令：

```bash
npm run dev
npm test
npm run check
npm run test:browser
```

浏览器回归测试使用本机 Google Chrome 和 Playwright WebKit，以 iPhone 13 视口运行。首次运行需执行 `npx playwright install webkit`。测试通过独立的 `127.0.0.1:3219` 服务、临时状态目录和模拟 App Server 执行，不连接正式 Codex 会话。

详细的产品边界、状态权威、写锁状态机与测试要求见 [架构与产品约束](docs/architecture.md)。

## 平台与部署说明

Pocket 的产品定位不是 macOS 专属：核心服务基于 Node.js、Codex CLI 和 App Server，WebUI 由移动设备浏览器访问。部署到其他操作系统时，需确认该平台支持所用 Codex CLI，并按平台配置进程托管、PATH、用户数据目录、文件权限和私密 HTTPS 入口；这些平台适配工作不改变 Pocket 与 Desktop / CLI 的协作边界。

## 以服务运行

长期运行时，使用操作系统的服务管理器启动 `server.mjs`，并确保服务用户的 `PATH` 能找到独立安装的 Codex CLI。Pocket 不依赖 Codex Desktop 进程；登录会话、主机休眠和网络可用性则由具体平台与部署方式决定。

## 通过 Tailscale 私密访问（部署示例）

当前部署示例通过 Tailnet 内的 HTTPS 3210 端口提供服务。Tailscale 管理后台需启用 MagicDNS 和 HTTPS 证书；配置命令为：

```bash
tailscale serve --bg --https=3210 http://127.0.0.1:3210
tailscale serve status
```

手机连接 Tailscale 后，通过自己的 MagicDNS 完整域名加端口访问；以下主机名为占位符：

```text
https://<machine>.<tailnet>.ts.net:3210
```

Tailscale Serve 在 Tailnet 内处理 HTTPS 和证书，将请求代理到本机 HTTP 服务。使用 HTTPS 可启用 Service Worker 和离线页面壳；离线时不能继续执行 Codex 任务。

iPhone 可在 Safari 分享菜单中选择“添加到主屏幕”；Android 可使用浏览器的安装或添加到主屏幕入口，具体支持以浏览器为准。

保持网关只监听 `127.0.0.1:3210`，不要添加公网端口映射或使用 Tailscale Funnel。Tailscale 命令语法以 [Tailscale Serve 官方文档](https://tailscale.com/docs/reference/tailscale-cli/serve) 为准。

## 配置

`config/projects.json` 是可选的主机本地项目覆盖配置，不应提交；没有该文件时服务使用空覆盖。字段结构示例见 [`config/projects.example.json`](config/projects.example.json)。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POCKET_HOST` | `127.0.0.1` | 网关监听地址；建议保持 loopback |
| `POCKET_PORT` | `3210` | 网关端口 |
| `CODEX_BIN` | `codex` | Codex CLI 可执行文件路径 |
| `CODEX_DEFAULT_CWD` | 当前项目目录 | App Server 的启动目录 |
| `POCKET_IDLE_RELEASE_MS` | `180000` | 对话完成后释放 Pocket writer 的空闲时间（毫秒） |
| `POCKET_REQUEST_DB_PATH` | `~/.codex/codex-pocket-requests.sqlite` | Pocket 独占的请求日志；需持久保存，以便重启后查询和去重 |
| `POCKET_IMAGE_DIRECTORY` | `~/.codex/codex-pocket-images` | Pocket 独占图片目录；文件以内容指纹命名并保留供历史消息查看 |
| `POCKET_OVERLAY_PATH` | `~/.codex/codex-pocket-state.json` | Pocket 独占的项目归属与权限覆盖文件 |

## 当前生产实例的安全建议

- 保持 `POCKET_HOST=127.0.0.1`，由 Tailscale Serve 代理，不要监听 `0.0.0.0`。
- Tailscale Serve 只保留 `HTTPS 3210 -> http://127.0.0.1:3210`，不要暴露到普通局域网接口。
- 使用 Tailscale Grants/ACL，仅允许自己的设备访问这台 Pocket 主机。
- 不要配置 Funnel、公共反向代理或路由器端口转发。
- 丢失手机时，从 tailnet 移除对应设备并停止 Pocket 服务。
- 审批卡片会显示命令或文件变更；确认内容后再允许。

## 发送状态与恢复

新页面在发送前保存请求编号和对应草稿，服务端在执行前把请求记入 Pocket 独占 SQLite 日志。HTTP 响应丢失时，页面会查询原请求结果；只有服务端确认未收到时，才提供使用原编号重试的入口。

若服务端在执行期间重启，或 App Server 的响应无法确定，页面显示“执行结果待核对”，保留草稿并阻止盲目重发。先检查会话内容和任务状态，确认后可点击“已核对，结束跟踪”；这不会自动再次发送。已确认的请求可在重启后恢复原结果。这里的“已确认送达”表示服务端接受了操作，不表示 Codex 已完成任务。

草稿与请求跟踪信息保存在当前浏览器，不能跨设备自动同步。浏览器拒绝持久保存请求时会阻止发送并保留输入。清除站点数据会清除这些本地记录；会话本身仍保存在 Pocket 主机对应的 Codex 用户目录中。

## 诊断与缓存版本

点击右上角连接状态可查看运行诊断：最近会话同步时间、HTTPS / Service Worker 状态、资源版本、网关运行时间、各会话 worker 与释放时间、近期服务错误。查看诊断不会创建 writer。会话上方的“释放会话”只停止 Pocket 自己持有的空闲 worker；运行中、等待审批或排队写入时不能被提前释放。

服务启动时读取全部 `public/` 资源并计算内容指纹，将源码中的 `__BUILD__` 替换为同一版本。页面、模块、Service Worker 预缓存和前端会话缓存一起切换；草稿、阅读位置和未决请求保留独立的稳定存储键。修改文件后需要重启服务；无需手动修改版本号。离线页面壳仍可打开，图片与会话操作需要连接本机服务。

## 已知限制

- CLI、Desktop 和 Pocket 能看到同一 Pocket 主机、同一 Codex 用户目录里的本地任务。若原任务仍由另一客户端占用，Pocket 会先征求确认；选择“创建副本继续”后才会 fork，并在副本中发送消息，原任务保持不变。
- Pocket 只会停止自己启动的 App Server，不会结束 Desktop 或 CLI 进程。对话完成且没有待处理审批时，writer 会在默认 3 分钟后释放。
- 一个正在处理或等待审批的 Pocket 会话对应一个本地 App Server worker；并行活跃会话会占用额外内存，但彼此不会互相阻止释放 writer。
- Pocket 主机休眠 / 离线、Codex 未登录或当前私密网络入口不可用时，手机端无法继续会话。
- Codex Desktop 可以退出；Pocket 使用独立 CLI 和自己的 App Server 子进程。当前 macOS 用户级 LaunchAgent 部署在用户退出登录后会停止。
- 图片支持 PNG、JPEG、WebP，每条最多 4 张，每张不超过 10 MB。暂不支持任意文件附件；其他客户端创建的图片若无法映射到 Pocket 图片目录，会提示在电脑查看。
- 上传中的图片保存在浏览器 IndexedDB，草稿引用在 localStorage；清除站点数据会丢失尚未发送的草稿。Pocket 主机上的图片按内容去重且不会自动清理，以保留已发送消息的引用。
- 差异显示每个文件最多 40,000 字符、每个修改条目共 200,000 字符，截断时会提示；命令输出保留末尾 20,000 字符。
- App Server 是 Pocket 主机上的子进程；网关退出时它也会停止，但已有 Codex 会话不会被删除。

协议实现参考 [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 手机通知、更新与存储

点击右上角连接状态打开「运行诊断」，展开「通知与存储」即可管理。通知默认关闭，仅在你点击开启并允许系统权限后订阅。iPhone 需要先将 HTTPS 入口添加到主屏幕，再从该入口打开并开启通知；仍需连接当前私密网络才能打开会话。Pocket 主机需保持在线并能够访问浏览器推送服务。

通知显示通用的完成、失败或等待确认提示，不含任务标题、正文或命令。推送经过浏览器厂商的服务，使用 Web Push 加密；点击通知会保留当前草稿再打开对应会话。Pocket 执行的完成、失败和审批由实时事件触发，Desktop / CLI 的新完成活动由本地状态轮询补充；不会补发开启前的旧活动。关闭通知只影响当前设备。自动化测试使用模拟投递，不向真实设备发送通知。

新版本就绪后显示「保存并刷新」。系统会先保存草稿，并检查其他打开的 Pocket 页面是否正在发送或上传。没有使用中的旧资源缓存可以手动清理；新版本还在等待激活时会先要求完成更新。

图片清理会先列出候选文件，并在点击清理时再次核对引用。只有所有上传引用均被移除超过 24 小时、且从未用于发送的图片才会删除。已发送、发送结果不确定、旧版本创建或引用状态无法核对的图片都保留。清理阅读缓存不会清除草稿、图片草稿或发送记录；请求日志不做过期删除，以保持跨重启的去重语义。

当前分页减少了传到手机的数据和页面节点；Codex App Server 的完整历史读取仍可能发生在网关端。网关缓存设有 24 MB 总量上限。WebKit 自动化覆盖移动端布局、附件恢复、审批、更新和服务断连后的离线壳，但不等同于真实 iPhone 的安装、键盘、后台运行和通知投递验证。
