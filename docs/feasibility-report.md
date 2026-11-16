# dsh-tingbar 双平台（喜马拉雅 + 懒人听书）可实施性研究报告

> **说明**：本文档是开发历史研究记录，原始研究起点为 [`jerryqx/dsh-ximalaya`](https://github.com/jerryqx/dsh-ximalaya)（喜马拉雅单平台插件）。本仓库 `dsh-tingbar` 是它双平台化（喜马拉雅 + 懒人听书）后的独立延续，版本从 `0.1.0` 重新开始。

> 研究日期：2026-11-15 · 研究环境：Windows 11 + DSH Desktop 0.2.2-rc.3（`D:\Program Files\DSHarness`）+ GUI `http://127.0.0.1:7206`
> 研究方式：源码审读 + 单测/集成测试 + 真实网络探测（匿名与登录态）+ 对懒人听书 Web 前端产物做逆向
> 结论先行：**可实施**。喜马拉雅侧已被完整验证（含扫码登录与付费态判定）；懒人听书侧扫码登录、专辑/目录/主页已验证，搜索与播放地址**被强制登录**，但登录后链路在协议层已完全还原并实现。两平台已统一到一层 provider 契约，插件升级为 `0.6.0`，测试 100 用例全绿，Host 侧已在运行中的 DSH 里实测通过。

---

## 1. 研究对象与现状

| 项 | 值 |
|---|---|
| 上游插件 | `https://github.com/jerryqx/dsh-ximalaya`（HEAD `2fbd829`，全部提交 2026-08-26） |
| 版本 | `0.5.2`（本报告完成后为 `0.6.0`） |
| 代码规模 | `lib/xmly.js` 721 行 · `lib/index.js` 655 行 · `lib/client.js` 1470 行 · 测试 3 文件 56 用例 |
| 结构 | Host 面（`lib/index.js`，`inject = ['webServer','fs','shell','tools','systemPrompt']`）+ Web 面（`lib/client.js`，`__ModuleLoader__` + `slots` 注入） |
| 运行方式 | `cordis.patch.yml` 插入一行 `tingbar-player` 自动组对；状态落盘 `~/.dsh/tingbar-state.json` |

**基线验证**：`npm install` 后 `npx vitest run` = 3 文件 / 56 用例全通过；仅有一条 jsdom 的 `activeElement.detachEvent is not a function` 噪声（`lib/client.js:789` 的 `focus()`），与功能无关。

**契约兼容性审计**（对安装内 `app.asar` 的 `@deepseek-ai/*` 源码逐项比对）：插件依赖的 5 个 service 全部存在；`ctx.webServer.register({kind:'prefix', path, handler})`、`ctx.tools.register(defineTool(...))`（`parameters` 仍接受裸 JSON Schema）、`ctx.systemPrompt.section({name, order, text})`、`slots.inject/register`、`conversation.input.dock` / `shell.overlay` 插槽 id、`dsh.client` 打包契约 —— **无一变更**，因此原插件在 0.2.2-rc.3 上可直接激活（后续已实测确认）。

---

## 2. 真实网络探测证据

### 2.1 喜马拉雅（匿名可测）

| 探测 | 结果 |
|---|---|
| `searchAlbums('三体')` | 200，`total 1995`，首条 `40121646`（三体｜有声书全本无删减｜王明军单播｜刘慈欣原著） |
| `albumSimple(40121646)` | 200，`isPaid=true`，anchor=三体宇宙 |
| `albumTracks(40121646, 1, 5)` | 200，`totalCount 313`，条目正常 |
| `qrCreate()` | 200，真实 `qrId` + 4450 字节 `data:image/png` 二维码 |
| `trackJson(<付费曲目>)` | 返回 32 字段但 `play_path_64` 为空 ⇒ 免费直链不存在，需登录态 |

⇒ **喜马拉雅：免登录可搜索/浏览/播免费内容；VIP/已购内容依赖扫码登录后的 `baseInfo` 解析**。这两条链路插件原本都已实现且本次实测仍然有效。

### 2.2 懒人听书（本次研究的重点）

站点为 TME 系新 SPA（`www.lrts.me` 与 `www.lanrentingshu.com` 同一产品，前端产物根 `https://assets.lanrentingshu.com/fed-lrts-web/20261110203925/`，116 个 chunk）。**关键手段：把这 116 个 chunk 全量下载后逆向**，从而拿到确定性协议，而不是靠抓包猜。

| 能力 | 端点 | 匿名可用？ | 说明 |
|---|---|---|---|
| 详情 | `GET /api/book/detail?id=84` | ✅ | `apiStatus:0`；史上第一混乱 / 张小花 / 有声刘忙 / 播放 231119442 |
| 目录 | `GET /api/book/resource?bookId=84&pageNo=1&pageSize=N` | ✅（但 `path` 为空） | `sections:302`；条目含 `id/section/name/length/listenPrice/feeType/buy/cantListen` |
| 首页推荐 | `GET /api/home/webHomePage` | ✅ | `recommendEntityList` 20 条（单田芳等） |
| 扫码登录 | `POST /api/user/webQrCreate` | ✅ | `{sceneToken(64 hex), expireAt}` |
| 扫码轮询 | `POST /api/user/webQrStatus` `{sceneToken}` | ✅ | `waiting` / `expired` / `success`；GET 会 405 |
| 用户信息 | `GET /api/user/getUserInfo` | ❌ `9999 请先登录` | 登录后返回昵称/VIP |
| 搜索 | `GET|POST /api/search/searchBookAlbum` | ❌ `485 需要登录才能继续使用此功能` | 强制登录 |
| 播放地址 | `GET /api/gateway/getListenPath` | ❌ 同上 485 | 强制登录 |
| 榜单 / 分类树 | `/api/ranking/resList`、`/api/category/getBookType` | 下线/空 | 不可用 |

**从 chunk 还原出的确定性协议细节**（`B9cgP1xy.js`、`BbhgXFXk.js`、`CO3S2Chi.js`、`Zkur3pYC.js`）：

- 播放地址：`getListenPath` 参数 `{ entityType: Book?1:2, entityId: bookId, trackId, section: i.section ?? i.sortNum ?? 0, resId, opType: 0, quality: 1, _t }`，取 `data.path || data.listenPath`；空则前端报 `empty-listen-path`「播放资源暂不可用」。
- 信封常量：`SUCCESS=0`、`WEB_SUCCESS='success'`、`LOGIN_REQUIRED=485`、`NOLOGIN=9999`；**全站无 `Authorization` 头 ⇒ 纯 cookie 鉴权**，这对 Host 端代理非常友好。
- 扫码：二维码内容不是服务端图片，而是 `https://m.lrts.me/activity/webQrLogin/index?sceneToken=<token>`，需**自己渲染**；`expireAt` 可能是秒也可能是毫秒（`e > 1e10 ? e : e*1e3`）；轮询间隔 1200/2000/3000ms。
- 播放前置：网页播放器 `if (!await ensureLogin()) return false` ⇒ **连免费章节也要求登录**，这是产品设计而非插件缺陷。

⇒ 结论：懒人听书**没有不可逾越的协议障碍**，风险集中在「登录态是否稳定」与「cookie 时效/风控」。为此插件额外实现了 `POST /login/cookie` 粘贴 cookie 的兜底通道。

---

## 3. 可实施性判定与风险

| 维度 | 喜马拉雅 | 懒人听书 |
|---|---|---|
| 搜索 | ✅ 免登录 | ⚠️ 需登录 |
| 专辑/目录 | ✅ | ✅ |
| 播放免费内容 | ✅ 免登录 | ⚠️ 需登录 |
| 播放已购/VIP | ✅ 需登录 + 账号有权限 | ⚠️ 需登录 + 账号有权限 |
| 扫码登录 | ✅ 服务端出图（data URL） | ✅ 服务端出 token，**需本地生成二维码** |
| 云端收藏/订阅/关注 | ✅ 读 + 部分写 | ❌ 网页端未暴露等价接口 |
| 总体风险 | **低**（已被前作与本次实测双重验证） | **中**（登录后链路协议已还原，缺端到端登录态实测） |

懒人听书的三级兜底（已内置到方案，不是事后补救）：

1. **粘贴 cookie 登录**（`POST /dsh-tingbar/login/cookie`）—— 扫码通道若被风控，从浏览器开发者工具复制 cookie 即可登录；
2. **只读浏览**——详情/目录/首页免登录可用，「能看不能播」也保留了目录检索价值；
3. **降级到 App 侧试听**——插件明确提示「该内容暂无可用播放地址」，不做绕过。

不做的事：不伪造签名、不绕过付费墙、不上报收听历史（对端无接口）。

---

## 4. 实施方案（已落地）

### 4.1 分层

```
lib/providers/index.js     平台注册表 + 契约（PROVIDERS / PLATFORM_IDS / DEFAULT_PLATFORM / isPlatform / providerOf / platformsMeta / labelOf）
lib/providers/ximalaya.js  适配 lib/xmly.js（原有协议代码零改动，56 个既有测试继续有效）
lib/providers/lrts.js      全新：cookie 鉴权、485/9999 错误映射、二维码本地生成、目录归一化、getListenPath
lib/index.js               Host：所有路由带 ?platform=，按 provider 分发；状态 v2（分平台账号/收藏/进度）
lib/client.js              Web：面板头部平台切换器、登录门槛提示、按平台拼参数
```

统一契约（Host 与 Web 只认这套）：`id / label / needsLogin{search,browse,play,mine} / supports{...} / qrCreate / qrCheck / user / search / album / tracks / resolvePlay / streamHeaders / errorInfo`（喜马拉雅额外实现 `following / likes / subscriptions / anchor / write`，懒人听书额外实现 `home`；未实现的能力由 Host 统一回 `501 {unsupported:true}`）。

### 4.2 关键实现决策

| 决策 | 理由 |
|---|---|
| 保留 `lib/xmly.js` 不动，用 adapter 包一层 | 721 行已稳定的签名/解密逻辑不动，风险最低，回归测试免费 |
| 状态文件升级为 `version: 2` 并自动迁移 v1 | 老用户升级不丢登录态与收藏 |
| `?platform=` 显式非法值回 **400**，而非静默回退 | 早暴露客户端 bug；`/manifest` 不带 platform 时按 Host 持久化偏好返回（否则刷新会用客户端默认值覆盖用户选择） |
| 工具沿用 `ximalaya_play` 名字，新增 `platform` 参数 | 兼容既有提示词与用户习惯，避免改名破坏已安装用户的调用路径 |
| 懒人听书二维码由 Host 端用 `qrcode` 生成 | 服务端只给 `sceneToken`，图片必须自己画 |
| 播放缓存 key = `platform + ':' + trackId`，TTL 10 分钟 | 两个平台 id 空间可能撞车，必须隔离 |
| 切换平台时暂停并释放音频 | 避免两平台音频流抢控制器；进度已存 Host，可续听 |
| 懒人听书「我的」页只保留本地收藏 | 对端无云端收藏/订阅/关注接口，不做假界面 |

### 4.3 变更文件

| 文件 | 性质 |
|---|---|
| `lib/providers/index.js`、`lib/providers/ximalaya.js`、`lib/providers/lrts.js` | 新增 |
| `lib/index.js` | 重写（平台感知、状态 v2、`/platforms`、`/home`、`/login/cookie`） |
| `lib/client.js` | 改造（切换器、登录门槛、按平台参数、`needAuth/needLogin` 兼容） |
| `test/providers.test.js`、`test/lrts.test.js` | 新增 |
| `test/index.test.js`、`test/client.test.js` | 扩展 |
| `package.json` | `0.6.0`、`dependencies.qrcode ^1.5.4` |
| `README.md`、`docs/feasibility-report.md` | 文档 |

---

## 5. 验证记录

### 5.1 单元/集成测试

`npx vitest run` → **5 文件 / 100 用例全通过**。覆盖：provider 注册表与契约、懒人听书全部错误映射与归一化（mock `fetch`）、Host 各路由的多平台行为（含 400 / 501 / 状态迁移 / 缓存隔离）、Web 端切换器渲染与 `prefs` 写回。

### 5.2 Host 端真实网络端到端（`apply()` 起在 18124 端口，真实上游）

manifest 双平台；`?platform=lrts` 生效；非法平台 400；`/home?platform=lrts` 200（20 张专辑）；`/home?platform=ximalaya` 501；`/album?id=84&platform=lrts` 200（302 章）；`/tracks` 200（`maxPageId 31`）；匿名 `/search?platform=lrts` 401；`/following?platform=lrts` 501；`POST /qr/create?platform=lrts` 200（`sceneToken` 64 位、图片 4062 字节）；过期 token 400；喜马拉雅 `/search?kw=三体` 200；`/play?trackId=325617128` → 403 `needLogin:true`（付费曲目正确）；`prefs.platform→lrts` 后 `/manifest` 返回 lrts；工具调用产出 `{action:'play', platform:'ximalaya', ...}` intent。

### 5.3 在运行中的 DSH 里实测

`plugin_manager` 确认 `include:tingbar-player` 处于 `fiberPhase: active`；`GET /dsh-tingbar/manifest` 返回新的双平台结构；`/dsh-tingbar/home?platform=lrts` 200。开发期用目录 junction（`profiles/desktop/node_modules/dsh-tingbar` → 仓库）实现改代码即生效；**禁/启用插件一次即可热重载 Host，无需重启 DSH**。

### 5.4 尚未完成的验证（需人工扫码）

- 懒人听书：扫码登录 → 搜索 → 取播放地址 → 实际出声（VIP 章节同理）；
- 喜马拉雅：扫码登录 → 付费/已购曲目出声（`baseInfo` 路径）；
- Web 面在实际 GUI 里的视觉确认（播放条出现、切换器可点）。

---

## 6. 替代方案评估

| 方案 | 评价 |
|---|---|
| 做成两个独立插件（`dsh-tingbar` + `dsh-lrts`） | 播放条/面板会重复出现两份，用户要开两个浮层，体验不可接受 ⇒ 否决 |
| 用官方开放平台（`earth-openapi.lazyaudio.com`）替代网页端接口 | 需要企业资质与 API key，个人场景不可行；且内容覆盖不等于网页端 ⇒ 仅作长期备选 |
| 懒人听书只做「目录检索 + 跳转 App 试听」 | 可作为失败兜底（已内置提示文案），但既然协议已还原，完整做出来更有价值 ⇒ 降级为兜底 |
| 用 WebView 内嵌对端页面 | 登录态与播放器行为受 X-Frame/CSP 约束，且无法与本插件播放条共享控制 ⇒ 否决 |

---

## 7. 遗留与后续

1. **端到端登录态实测**（唯一未闭环项）：需两个平台各扫一次码，验证 VIP/付费章节实际出声。
2. 懒人听书「新书上架/榜单」类入口不可用（对端已下线），首页只保留 `webHomePage` 推荐。
3. 懒人听书切平台后不保留面板搜索状态（v1 简化，切换即清空），后续可按平台缓存面板状态。
4. 若后续懒人听书给网页端补上云端收藏/订阅接口，provider 契约已预留 `supports` 位，补实现即可开放。

---

## 8. 结语

- 原插件质量足够好：Host/Web 分层清晰、协议层无外部依赖、56 个测试全绿，且与新 DSH 的契约零冲突 —— **有继续演进的价值，不需要重写**。
- 双平台化没有踩到协议死胡同：真正的工作量在于「把懒人听书的前端产物逆向成确定性协议」与「把两套异构 API 收敛成一层契约」，两者都已完成。
- 风险点唯一且明确：对端强制登录。这既是对端设计，也带来 cookie 时效问题 —— 已用「扫码 + 粘贴 cookie 兜底」两条通道覆盖。

**判定：可实施，且已实施。**

---

## 9. 第二轮迭代（0.6.1）：用户反馈的三处体验问题

上线试用后用户提出三条：目录「加载更多」永远只出第一页；喜马拉雅「我的」缺历史；懒人听书「我的」缺历史与收藏且新收藏不自动出现。逐条查证结果：

### 9.1 「加载更多」只出第一页 —— 根因在对端

| 探测 | 结果 |
|---|---|
| `/api/book/resource?bookId=84&pageNo=1/2` `page` `currentPage` `pageIndex` `start` `offset` `asc` `sort` | **全部返回同样的前 30 条**（`8400000001` 起），服务端完全忽略分页参数 |
| `pageSize=500/1000` | 返回 `min(章节数, 1000)` 条；302 章的《史上第一混乱》一次给 302 条 |
| 4775 章的书（id `94326793`）各种深页参数 | 上限恒为 1000 条 ⇒ 深页匿名不可达 |
| `/api/album/getAlbumAudios` 各种参数组合 | 恒 `status:500 ERROR` ⇒ 该接口已废弃，弃用 |

结论：**不是插件的翻页 bug，是对端根本没有分页能力**。方案改为「一次取满（`pageSize=1000`）+ Host 端本地切片 + 10 分钟缓存」，前端改为 `IntersectionObserver` 滚到底部自动追加，并按 id 去重（防上游偶发重复返回）；超过 1000 章的书籍置 `truncated` 标记并在列表底部说明。

真实上游复验（`book=84`）：page1/2/3/11 分别返回 30/30/30/2 条，首条为 `8400000001#1`、`8400000031#31`、`8400000061#61`、`8400000301#301`，**无重叠**；缓存命中耗时 0ms；4775 章的书 `truncated=true, maxPageId=34`。

### 9.2 收听历史 —— 统一由 Host 本地记录

查证：喜马拉雅网页端没有收听历史接口；懒人听书的云端历史是前端 `localStorage`（`lr_listen_history_v1`）按用户 scope 镜像 + 私有同步协议（`addRecentListen` 带 `list:JSON.stringify({list:[…]})`），两边口径不一致。

决策：**历史统一存 Host 端**（`state.recent[platform]`，按 `trackId+albumId` 去重，各保留 60 条，`/prefs` 写入播放快照时顺带记一笔），两个平台同一套结构、不依赖登录。新增 `GET /recent`、`POST /recent/clear`。

### 9.3 云端收藏（懒人听书）—— 已实现，需手动刷新

从懒人前端 `userLibrary` composable 挖到：`POST /api/collection/getCollectionBooks`，调用处传 `{ids:'0'}` 一次取回全部收藏，列表项 `updateState===2` 表示已取消。已实现 `provider.collections()` + `GET /cloud/favs`（喜马拉雅该能力位 `supports.cloudFavs=false` → 501）。

因收藏属于「用户主动改、偶发查看」的外部状态，故不做轮询，改为「我的」页右上角 **↻ 刷新** 一键拉新。

### 9.4 本轮验证

`npx vitest run` → **115 用例全绿**（新增：lrts 本地切片/缓存/`truncated`/`force`/`collections`，host `/recent`、`/recent/clear`、`/cloud/favs` 能力差异，Web 端滚动哨兵自动加载与去重、↻ 刷新按钮）。

---

## 10. 第三轮迭代（0.6.2）：history 改读云端 + 懒人听书播放协议修正

### 10.1 需求修正：历史必须跨设备，本机记录作废

用户反馈（m01212 原文摘要）：电脑端与手机端会切换听书，本机记录的历史没法同步「会很麻烦」；并给出两个平台的网页端位置——懒人听书 `https://www.lanrentingshu.com/user/history`（收听记录）、喜马拉雅 `https://www.ximalaya.com/my/listened`（听过）。

据此**推翻了 9.2 的决策**：删掉 `state.recent`、`/recent`、`/recent/clear`、`recordRecent*` 等全部本机历史代码，改为一个**账号级接口** `GET /dsh-tingbar/listened`，两平台各自映射：

| 平台 | 接口 | 数据结构 | 翻页 |
| --- | --- | --- | --- |
| 喜马拉雅「听过」 | `GET /revision/my/getListened?pageNum=&pageSize=` | `data.today[] / yesterday[] / earlier[]` + `totalCount`（实测 283 条，单页 `earlier` 100 条） | `pageNum`（`pageSize` 被忽略） |
| 懒人听书「收听记录」 | `GET /api/collection/getRecentListenBooks?srcType=101&referId=` | 信封根节点 `list[]` + `referId` 游标（实测个人 7 条） | `referId` 游标 |

匿名行为差异（重要）：喜马拉雅匿名 → `{"ret":401,"msg":"need login!","isNeedLogin":true}`；懒人听书匿名**不报错**，而是返回 55 条全局默认流（换 bogus cookie 也不变），所以「没登录」必须由插件自己判定（`loggedIn(platform)`）而不是靠响应内容。

字段归一化：喜马拉雅 `trackId/trackTitle/trackCover(相对路径，补 https://imagev2.xmcdn.com/)/albumId/albumName/anchorName/trackDuration("05:55"→355s)/createAt/createAtStr`；懒人听书 `sonId→trackId、bookId→albumId、resourceName→trackTitle、listpos→section（续播定位用）、playpos→position（秒）、duration、lastListenTime/date`。前端「我的 → 🕘 历史」两平台共用一套渲染，点击按 `section`+`position` 续播。

### 10.2 懒人听书播放一直不工作的真相：`tmeId`

上一轮把「登录后 `path` 为空」一律判成 `NEED_VIP`，其实根因是**参数用错了**：`/api/gateway/getListenPath` 的 `trackId`（以及 `resId`）必须是章节的**腾讯音乐资源号 `tmeId`**，不是 `sectionId`/章节 `id`。实测对照（`bookId=84`，均已登录）：

| 参数 | 结果 |
| --- | --- |
| `trackId=tmeId(1036000702), resId=tmeId` | `status:0`，`path=https://vb.stream.tencentmusic.com/long/…m4a?uid=…` ✅ |
| `trackId=tmeId`（不带 resId） | `status:0`，同上 ✅ |
| `trackId=sectionId(8400000001)` | `status:20`，`path` 空 |
| `trackId=id, resId=tmeId` | `status:20`，`path` 空 |
| `entityType=2` / `4` | `status:4` / `-2`（书籍固定 `entityType=1`） |

修正：`toTrack` 透出 `tmeId`；`resolvePlay({trackId, tmeId, albumId, section})` 优先用 `tmeId`，缺失时用目录缓存按 `section` 反查（所以从云端历史续播也能播，历史项里没有 `tmeId`）；`status:20` 单独给「资源号无效/章节不存在」的可读错误，不再谎报会员权限。Host 侧 `/play`、`/stream` 增加 `tmeId` 透传，播放缓存键改为 `platform:trackId:tmeId`。

### 10.3 本轮验证

- 单测：`npx vitest run` → **5 文件 / 122 用例全绿**。新增/改写：lrts「tmeId 才是播放凭据」「没带 tmeId 回查目录」「既无 tmeId 又查不到 → `BAD_ARGS`」「`status:20` → 可读错误」「`getRecentListenBooks` 归一化 + `referId`」「`tracks` 透出 `tmeId`」；host「`/listened` 未登录 401 `needLogin`」「`pageNum` 透传」「`/recent` 已下线 404」；契约测试新增 `listened` 与 `cloudHistory` 能力位；Web 端「历史默认读 `/listened`」「↻ 刷新命中 `/listened`」。
- 真实上游 e2e（临时 `DSH_HOME` 里塞入真实登录态，起 Host 打真接口）：
  - `GET /dsh-tingbar/listened?platform=ximalaya` → 200，`totalCount=283`，100 条，首条 `trackId 1017788628`「神秘复苏 第97集」`2天前`；
  - `GET /dsh-tingbar/listened?platform=lrts` → 200，7 条，首条 `trackId 4906517800010805 / albumId 49065178 / section 805 / position 20`；
  - 从该历史项直接 `/play?platform=lrts&trackId=…&albumId=…&section=805` → 200（**没有 tmeId 也解析成功**），随后 `Range: bytes=0-1023` 打 `/stream` → **206 `audio/mp4` 1024 字节**；
  - 目录取 `tmeId` 后 `/play` → 200，`/stream` 同样 206；
  - 非法平台 → 400「未知平台（可用：ximalaya / lrts）」。

至此「电脑 + 手机换着听」的历史同步（账号云端）与「懒人听书真正出声」两项都已闭环到可复现的实测证据。

---

## 11. 第四轮迭代（0.6.3）：会员（VIP）状态识别

### 11.1 症状与根因

用户反馈：面板里懒人听书账号一直显示「普通账号」，但该账号确实是会员。

根因是**字段猜错了**。旧的 `normalizeUser()` 这样判定：

```js
const vipLevel = num(pick(raw.vipLevel, raw.vip_level))
const isVip = vipLevel > 0 || Number(pick(raw.isVip, raw.vipStatus)) > 0 || !!raw.vipInfo
```

而 `/api/user/getUserInfo` 的响应里 **`isVip` / `vipLevel` / `vipStatus` / `vipInfo` 四个字段一个都没有**（实测 78 个字段，见下表），`pick()` 全落空 ⇒ `isVip` 恒为 `false`。

### 11.2 两平台的真实会员字段

| 字段 | 喜马拉雅 `/revision/main/getCurrentUser` | 懒人听书 `/api/user/getUserInfo` |
| --- | --- | --- |
| `isVip` | ✅ `true`（布尔） | ❌ 不存在 |
| 到期/剩余 | `vipExpireTime: 159`（**剩余天数**，非时间戳） | `vipExpireTime: 1826512800999`（**毫秒时间戳**）+ `timeRemaining: 368`（天数） |
| 档位/等级 | `vipLevel: 5`、`totalVipDays: 2932` | `vipType: 0`（0=普通会员） |
| 其他旁证 | `mvpGrade`、`anchorGrade` | `feeType: 3`、`memberSectionCount` |

注意两边 `vipExpireTime` **同名不同义**：喜马拉雅是天数、懒人听书是毫秒时间戳。直接混用会把 2027 年当成 1970 年，所以归一化时必须按量级判断（`>= 1e12` 才当时间戳）。

第三方资料对这两个字段没有公开文档（喜马拉雅只公开 open platform 的正式 API，网页私有接口无文档），因此判定依据来自**实测数据自洽**：懒人听书 `vipExpireTime - currentServerTime ≈ 368 天`，与 `timeRemaining: 368` 一致；喜马拉雅 `vipExpireTime: 159` 量级上只可能是天数。

### 11.3 实现

- `lib/providers/lrts.js` 的 `normalizeUser()` 重写：`vipUntil`（仅 `>= 1e12` 的时间戳）→ `vipDays = max(到期天数, timeRemaining)`，`vipLevel = vipType`；顺带修了头像——懒人听书头像字段叫 `cover`/`originCover`，之前也取不到。
- `lib/xmly.js` 的 `getCurrentUser()` 补 `vipLevel / vipDays / vipUntil`（天数口径）。
- `lib/index.js` 的 `platformSummary()`（manifest/`/platforms` 的 `accounts`）下发 `isVip / vipLevel / vipDays / vipUntil`。
- `lib/client.js`：新增 `vipBadge()` / `vipLine()`；「我的」页显示 `VIP Lv5` 徽标 + 「会员生效中 · 剩 368 天 · 2027-11-16 到期」，非会员显示「普通账号（VIP/已购内容可播）」；平台切换按钮上加 `VIP` 角标，title 里带昵称与剩余天数；新增 `loadUser()` 打 `/dsh-tingbar/user` 强制刷新（进入「我的」、点 **↻ 刷新** 各触发一次），续费/到期无需重启。

### 11.4 验证

- 单测：`npx vitest run` → **5 文件 / 130 用例全绿**。新增：lrts 会员四态（毫秒时间戳算出天数与等级、`vipType>0` 带等级、只有 `timeRemaining` 也算会员、已过期判普通账号）、host `accounts` 带会员字段且未登录平台为 false/0、Web 端 VIP 徽标与「剩 368 天」渲染。
- 真实账号实测（provider 直连上游）：

| 平台 | 昵称 | isVip | vipLevel | vipDays | vipUntil |
| --- | --- | --- | --- | --- | --- |
| 懒人听书 | fyxsky | **true** | 0 | **368** | 1826512800999 |
| 喜马拉雅 | 寻音人 | **true** | **5** | **159** | 0（上游只给天数） |

- 运行中的 DSH 热重载后实测：`/dsh-tingbar/user?platform=lrts` → `isVip=true, vipDays=368`；`?platform=ximalaya` → `isVip=true, vipLevel=5, vipDays=159`；`/manifest?platform=lrts` 的 `accounts` 两个平台都是 `vip=true`。

## 12. 第五轮迭代（0.6.4）：播放条「上一集/下一集」「快进/快退」失效

### 12.1 症状

用户反馈：播放/暂停正常，但 ⏮/⏭（上一集/下一集）与 ⏪/⏩（快退/快进）**点了没有任何反应**，两个平台都一样。

### 12.2 定位过程与证据

先用真实浏览器验证「传输层与 `<audio>` 能不能 seek」——排除对端/代理问题：

1. 起一个本地探针页（`<audio src=Host /stream 直链>`），用 Chrome 打开：`loadedmetadata duration=378.90322 seekable=378.90322`，脚本把 `currentTime` 从 0 设为 60，读回 **60**，`readyState=4` ⇒ **代理流可正常 seek，时长可算**。
2. 检查 m4a 容器布局：`ftyp@0 size=32`、`moov@32 size=36340` ⇒ moov 在前（faststart），浏览器能立刻拿到时长。
3. Range 透传：`bytes=500000-500999` 两平台都回 `206` + 正确 `Content-Range` + `Accept-Ranges: bytes`。

⇒ 传输层没问题，问题在 Web 端逻辑。逐行读代码后确认是两处**静默失败**：

- `seekBy()`：`const dur = audio.duration || store.duration || cur.duration`，`if (!(dur > 0)) return;` —— 从「历史」起播时 `cur` 上没有 `duration`（`playTrack` 的 target 没带），懒人听书 `/play` 也不返回时长，如果此时 `audio.duration` 还没就绪，`dur=0` 就直接 return，按钮等于失效，且**没有任何提示**。
- `step()`：只在 `store.albumTracks`（已加载的专辑分页）里找当前曲目，找不到就 `openAlbum(albumId, {autoAdvanceTo})`——那条路会重置列表再只拉第一页，而懒人听书常从第 800+ 集起播，第一页根本没有当前集，于是**同样静默失败**。

### 12.3 实现

- 新增 Host 路由 `GET /dsh-tingbar/neighbor?platform=&albumId=&trackId=&section=&dir=±1`，由 provider 的 `neighbor()` 在**完整目录**里定位相邻章节：
  - 懒人听书：读 `SECTION_CACHE`/一次取满的目录，按 `section` 定位（`sectionId` 兜底）。
  - 喜马拉雅：按 `trackId` 逐页翻（每页 30，最多 60 页），跨页时取相邻页边界项；到头返回 `track=null`。
- Web 端 `step()`：先查已加载列表（含「加载下一页后重试」），查不到就走 `/neighbor`，到边界提示「已经是最后一集/第一集」，出错弹提示。
- Web 端 `seekBy()`：时长改为四级回退（`audio.duration → store.duration → cur.duration → seekable.end`），完全没有时长也按相对偏移尝试；跳转后 500ms 校验一次，若没生效弹「跳转没生效（音频还在缓冲）」，不再静默。
- 起播上下文补 `duration`：目录条目、历史条目在 `playTrack` 时把自带时长写进 `current`，元数据就绪前也能显示总时长与算边界。

### 12.4 验证

- 单测：**5 文件 / 138 用例全绿**。新增 8 条：lrts `neighbor`（按 section 定位相邻、第一集边界返回 null、`trackId` 兜底、缺 `albumId` 报错）、host `/neighbor`（相邻曲目、边界 null、缺参 400 / 未知平台 400）、Web 端「从历史起播后点下一集 → 请求 `/neighbor` 并切到新曲目」。
- 运行中的 DSH 热重载后实测（真实登录态）：

| 平台 | 当前 | dir=+1 | dir=-1 | total |
| --- | --- | --- | --- | --- |
| 懒人听书（book 49065178） | section 810 | section 811（tmeId 1328039561） | section 809 | 880 |
| 喜马拉雅（album 130106749） | trackId 1017788628 | trackId 1017788601「第98集」 | trackId 1017788675「第96集」 | — |

- 真实浏览器 seek 基线（同上探针）：`duration=378.90`，`0 → 60` 成功，`readyState=4`。

## 13. 第六轮迭代（0.6.5）：远程诊断通道与「点了没反应」的收口

### 13.1 为什么需要它

0.6.4 修完 seek/上下一集后，用户复测仍报「快进快退不起效」，而命令行侧看不到任何异常：Host 只负责发流，真正的 `<audio>` 在浏览器里，`duration`/`seekable`/`error` 这些决定性数值在外面完全看不见。继续靠读代码猜没有出路，于是给插件加了一条诊断通道。

### 13.2 通道长什么样

- `POST /dsh-tingbar/diag`：Web 端上报现场数据（最近 40 条，环形缓冲）。
- `GET /dsh-tingbar/diag`：读回来。
- `POST /dsh-tingbar/diag/cmd`：下发一次性指令，Web 端在 `/intent` 轮询里取走并执行——`{op:"seek",delta:15}` / `{op:"step",dir:1}` / `{op:"snapshot"}`；执行完把「执行前快照 + 执行后 `currentTime`」报回 `diag`。
- 每次 bundle 加载留一条 `boot`（带 `CLIENT_BUILD` 标记），可确认页面里跑的是哪一版 Web 端代码。
- 手动点击同样留痕：`seek`（含 `from`/`target`/`duration`/`after`）、`seek-noop`（已到边界）、`step`（含 `albumTracks` 数量）。

### 13.3 用它得到的结论（真机、真点击）

在用户正在使用的 DSH 窗口上用 UIA `Invoke` 直接点播放条按钮（不是调函数，是点按钮），现场数据：

| 动作 | 前 | 后 | 结论 |
| --- | --- | --- | --- |
| ⏩ 快进 | 71.94s（播放中） | 86.94s → 87.39s | 生效 |
| ⏭ 下一集 | section 814「神秘复苏 第814集」 | section 815「神秘复苏 第815集 朋友圈1」（`tmeId=1328039424`，时长 339.7s；`albumTracks=0` 走 `/neighbor`） | 生效 |
| 诊断指令 seek +15 | 101.02s（暂停中） | 116.02s | 生效（暂停状态也能跳） |

`seekable` 恒为 `[[0, duration]]`、`readyState=4`、`errorCode=0`、媒体源是 `dsh-app://app/dsh-tingbar/stream?...`——自定义协议下 Range 与可跳转区间都正常。也就是说用户侧当初的失败点既不在传输层，也不在 `seekBy`/`step` 的逻辑，而是**页面里当时跑的还是旧 bundle**（旧 `seekBy` 在时长未知时静默 `return`、旧 `step` 只在已加载分页里找曲目）。

### 13.4 顺带补的两处健壮性

- `seekBy` 的所有「静默 return」改成了可见反馈：边界记 `seek-noop`、赋值异常 toast、500ms 校验未生效 toast。
- `diag` 用 `apiPost(...).catch(() => {})`——诊断自身绝不影响播放。

### 13.5 验证

- 单测：5 文件 / 138 用例全绿（诊断通道靠真机验证，不进单测断言）。
- 真机：见 13.3 表格，全部由 UIA 真实点击触发。

> ⚠️ 13.3 里「`seekable` 恒为 `[[0, duration]]`、自定义协议下可跳转区间正常」这个读数**是错的**，见第 14 节：那是当时那个 `<audio>` 元素在已知时长下被 `seekable.end(0)` 兜底算出来的假象，用全新元素复测 `seekable` 其实是 `[[0, 0]]`。

---

## 14. 第七轮迭代（0.6.6）：`dsh-app://` 下媒体不可 seek —— 真正的根因

### 14.1 症状与推翻上一轮结论

0.6.4 修完「时长未知就静默返回」之后，用户复测 **快进快退仍然毫无反应**。0.6.5 上线诊断通道后拿到页面内真实数据，才发现问题根本不在我们的逻辑里。

用 `{op:'fresh'}` 指令新建一个全新 `<audio>` 加载同一个流地址，读数：

| 读数 | 值 | 含义 |
|---|---|---|
| `duration` | 316.162902 | 时长算得出来 |
| `readyState` / `networkState` | 3 / 1 | 元数据与未来数据都就绪 |
| `errorCode` | 0 | 没有解码/网络错误 |
| **`seekable`** | **`[[0, 0]]`** | **浏览器认为整条媒体没有任何可跳转区间** |
| `currentTime = 30` 后立即读 | 0 | 赋值被丢弃，`seeked` 事件在 0 处触发 |
| `#t=30` 媒体片段 | `currentTime` 仍 0 | 片段定位同样无效 |

同一 URL 在页面里用 `fetch(src, { headers: { Range: 'bytes=100-199' } })` → **HTTP 206**、`content-range: bytes 100-199/1928316`、`accept-ranges: bytes`、实收 100 字节。**传输层完全正常**。同一 URL 换成 `http://127.0.0.1:<port>` 后，全新元素的 `seekable` 立刻变成 `[[0, 316.162902]]`、`currentTime = 30` 生效、`readyState = 4`。

结论：宿主页面跑在 `dsh-app://app`（Electron 注册的自定义协议）下，Chromium 的媒体管线对这种协议走「不可 seek 的流」路径——即使我们正确实现了 `Range`/`206`/`content-range`。这不是插件能通过改 HTTP 头解决的问题。

### 14.2 修法：播放改走 Host 的回环 http 源

- 插件启动后按需在 `127.0.0.1` 的**随机端口**上起一个小 `node:http` 服务，只服务音频流：`GET /<token>/stream?trackId=&platform=&albumId=&section=&tmeId=`，内部复用同一个 `relayAudio`（登录态 cookie、`Range` 透传、`403/404` 时重取直链全部照旧）。
- 路径里带一段随机 `token`（`Math.random().toString(36) + Date.now()`），因为回环端口对本机所有进程开放，不加 token 等于把付费音频白送；实测错误/缺失 token 均返回 `404`。
- 新增 `GET /dsh-tingbar/audio-origin` → `{ ok: true, base: 'http://127.0.0.1:<port>/<token>' }`；Web 端 `loadManifest()` 先取它，`streamUrl()` 拼成 `<base>/stream?...`，取不到时退回原来的 `/dsh-tingbar/stream?...`（能播，但快进快退不可用）。
- 响应头补 `access-control-allow-origin: *` 与 `access-control-expose-headers: content-range, content-length, accept-ranges`——页面源是 `dsh-app://app`，回环源属于跨源。
- 插件卸载/热重载时 `ctx.effect(() => () => closeAudioServer(), 'ximalaya: audio server')` 关端口，避免泄漏。

### 14.3 验证

| 项 | 结果 |
|---|---|
| 全新元素 + 回环源 `probeUrl` | `seekable=[[0,316.162902]]`、`currentTime=30` → 立即 30、`seeked` 后 30、`readyState=4` |
| 回环源带 Range 直取 | `206`、`content-range: bytes 1000-2000/2011335`、`audio/mp4`、1001 字节 |
| 错误 / 缺失 token | 均 `404` |
| 真机点 ⏩（播放中） | 23.36s → **38.81s** 生效 |
| 真机点 ⏪（播放中） | 51.17s → **36.17s** 生效 |
| 真机点 ⏭ | 切到下一集（`trackId …821`，时长 329.77s，`seekable=[[0,329.769796]]`，继续播放） |
| 端到端字段 | `boot` 里的 `src` 已是 `http://127.0.0.1:<port>/<token>/stream?...` |
| 单测 | 5 文件 / **139 用例全绿**（新增「播放源走 127.0.0.1 回环」1 条） |

### 14.4 代价

- 多一个本机监听端口（随机端口、随机 token、仅回环、随插件卸载关闭）。
- 播放地址不再同源，读 `Range`/`content-range` 需要 CORS 头（已加）；`<audio>` 本身不需要 `crossorigin`。
- 旧的 `dsh-app://` 相对路径保留为降级通道。

---

## 15. 第八轮迭代（0.6.7）：全量代码审查与修复

用户要求对 0.6.6 做一次完整、逐功能的代码审查（正确性 / 静默失败 / 性能 / 真实场景验证），本节记录审查结论与随审查修复的问题。

### 15.1 审查方法

- 通读 `lib/index.js`（1038 行）、`lib/client.js`（2182 行）、`lib/providers/*`、`lib/xmly.js` 与全部测试文件；
- grep 废弃路径残留（`/recent`、`recordRecent`、`sanitizeRecent`、`RECENT_LIMIT` 在 `lib/` 下 0 命中，且有 `/recent → 404` 的回归用例镇守）；
- 对存疑项（收听历史翻页语义）用真实登录态打上游接口取证。

### 15.2 发现并修复的问题

| # | 位置 | 问题 | 根因 | 影响 | 修复 |
|---|---|---|---|---|---|
| 1 | `lib/client.js` `loadListens()`、`lib/index.js` `/listened`、两平台 provider | 「加载更多」的尽头判定失真：客户端用 `items.length>=30` 猜，而喜马拉雅上游**不翻页**（实测 `pageNum=1` 与 `2` 返回完全相同的 100 条），必然出现一次「点了却没新内容」 | provider 的翻页能力没有透传到客户端 | 历史页出现无效按钮、多打一次上游请求 | provider 显式返回 `hasMore`（喜马拉雅恒 false；懒人按 `items>=pageSize` 游标判定）→ Host `/listened` 透传 → 客户端优先采用，老 Host 回退旧公式 |
| 2 | `lib/client.js` `ProgressBar` 点选 seek | 进度条点选直接赋 `currentTime`，无校验无提示——与 0.6.4 修过的 `seekBy` 同类静默失败 | 与 seekBy 的守护逻辑不一致 | 换集/缓冲中点进度条可能没反应且无提示 | 点选后乐观更新 + 500ms 校验（seq 守卫防旧定时器），未生效 toast 一次 |
| 3 | `lib/client.js` apply() | `intentTimer = setInterval` 在 effect 外创建，若后续 `slots.inject` 抛错，timer 泄漏 | 创建与清理分离 | 理论泄漏窗口 | 挪进 `ctx.effect(() => {...}, 'ximalaya: intent poll')` 成对创建/清理 |
| 4 | `lib/providers/index.js` 契约注释 | 仍写着「收听历史由 Host 本地记录」——0.6.2 起已是云端接口 | 迭代中注释没跟上 | 误导后续维护 | 改为 `listened()` 契约 + `supports.cloudHistory` 说明 |

### 15.3 审查确认无问题的项（含理由）

- **登录态/VIP**：两平台 `vipExpireTime` 同名不同义（懒人毫秒时间戳 / 喜马拉雅剩余天数）已分口径处理；会员过期态 `Math.max(0,…)` 归零判定正确；`loggedIn` 要求 nickname+cookie 双条件。
- **播放链路**：tmeId 进缓存键；`relayAudio` 403/404 清缓存重取一次、`res.close` 时 cancel 上游 body 无泄漏；回环源 token 校验 404、`ctx.effect` 卸载关端口。
- **懒人听书目录**：上游忽略一切分页参数（实测取证），「一次取满+本地切片+缓存」是唯一正确解；末页 `Math.min(start+size,total,list.length)` 截断正确。
- **neighbor**：懒人走 SECTION_CACHE 快；喜马拉雅逐页找最多 60 页属低频操作可接受。
- **缓存上限**：playCache/SECTION_CACHE 条目小（url/标题），TTL 覆盖，无膨胀风险；diagLog cap 40、streamLog cap 30。
- **QR 会话**：token 校验、过期置 null、单槽覆盖逻辑正确。

### 15.4 验证

- 真实上游取证：喜马拉雅 `pageNum=1/2` → first3/last 完全相同（100 条）；懒人 `referId` 翻页 → 第二页 0 条（7 条即全部）。
- 单测：新增 lrts `hasMore` 满页/不满页 2 条断言、index `/listened` hasMore 透传断言、client stub 同步 → **5 文件 / 140 用例全绿**。
- 运行中 DSH（set_bundle 热重载后）：`/listened?platform=ximalaya` → `hasMore:false, items:100, totalCount:283`；`?platform=lrts` → `hasMore:false, items:7, referId:<cursor>`。
- 编辑后校验 package.json/README/所有 lib 文件首字节均无 BOM。

## 16. 第九轮迭代（0.6.8）：真实头像、清理「本地」段、功能缺口盘点（热搜/排行榜）

用户提出四条：①「我的」显示真实头像；②懒人听书「本地」段若无实际用处可删；③「声音」段对应什么、是否可删；④对照网页版盘点还缺什么听书向功能（如排行榜）。

### 16.1 真实头像

- 喜马拉雅 `getCurrentUser` 的头像字段是 `logoPic`（协议相对 `//imagev2.xmcdn.com/...jpg`）→ `lib/xmly.js` 返回 `avatar`（补 `https:` 前缀）。
- 懒人听书 `getUserInfo` 的头像字段是 `cover`/`originCover`（`https://headpic.lrts.me/...`），`normalizeUser` 兜底链已覆盖，无需改动。
- Web 端「我的」页登录框优先渲染 `<img class="xmly-avatar">`（`object-fit:cover`），无头像时退回昵称首字。

### 16.2 删除懒人听书「★ 本地」段

懒人听书在插件里本来就有真正的云端收藏（`★ 收藏` = 账号书架，`getCollectionBooks`），「本地」段存的是插件自己 localStorage 式的收藏，**没有跨设备价值**（用户手机上收藏的书永远进不来）——删除。喜马拉雅的「★ 专辑」本地收藏保留：喜马拉雅网页端没有可读的「收藏专辑」接口，本地收藏是插件唯一的专辑收藏能力（从专辑页 ♡ 添加）。

### 16.3 「♥ 声音」段是什么、为什么保留

对应喜马拉雅 App/网页的「**我喜欢的声音**」：单集级收藏（点赞过的声音，`getLikeTracks`/`setLikeTrack` 接口）。它是**账号云端数据**（与手机同步）、可点击续播、可 ✕ 取消并同步回 App——不是无用功能，保留。懒人听书没有此功能（`supports.likes=false`），该段只出现在喜马拉雅下。

### 16.4 功能缺口盘点（对照两平台网页版，听书向）

| 网页版功能 | 插件状态 | 探测结论与处置 |
|---|---|---|
| 喜马拉雅 热搜词 | ✅ **0.6.8 新增** | `GET /revision/search/hotWord` 匿名可用（10 词）；搜索页空态显示「🔥 大家都在搜」，点即搜 |
| 喜马拉雅 排行榜 | ✅ **0.6.8 新增** | `GET /revision/rank/v2/element?rankId=1&pageSize=10` → 6 张榜（163 经典免费榜/69 有声书免费榜/77 相声评书免费榜/67 头条/68 音乐/70 娱乐），每榜自带前 10 专辑详情；搜索页「📈 榜单」展开，名次徽标 top3 高亮 |
| 喜马拉雅 搜索建议 | ❌ 不可行 | `/revision/search/suggest?kw=` → 404 |
| 懒人听书 排行榜 | ❌ 不可行 | `/api/ranking/resList` → `{"status":2,"msg":"榜单已下线"}`（官方下线，非风控） |
| 懒人听书 热搜/搜索建议 | ❌ 不可行 | `searchSuggest` 返回 SPA 空壳 HTML、`defaultRecommendList` 参数异常 |
| 懒人听书 分类浏览 | ❌ 不可行 | `getResourceList`/`typePage` 所有参数组合均「参数异常」或仅返回分类树无书单 |
| 喜马拉雅 分类浏览 | ❌ 不可行 | 无公开分类树/书单接口（`revision/album/<id>` 是 HTML 页） |
| 懒人听书 首页推荐 | ✅ 已有 | `/home`（`webHomePage`，匿名可用）保留为其唯一发现入口 |
| 登录/历史/收藏/订阅/关注/VIP/主播页 | ✅ 已覆盖 | 历轮已实现（见第 9–14 节） |

实现方式：`lib/xmly.js` 新增 `hotWords()` + `rankBoards()`（含 `normalizeRankAlbumDoc`）；provider 层 `supports.hotWords/ranks` 能力位（懒人 false）；Host 新增 `GET /dsh-tingbar/hots`、`GET /dsh-tingbar/ranks`（不支持 → 501 unsupported）；Web 端 `loadHots()/loadRanks()` + 搜索页热搜 chips/榜单区，`doSearch` 收起榜单，`switchPlatform` 重置发现态。

### 16.5 验证

- 单测：`test/index.test.js` mock `hotWords`/`rankBoards`，新增「发现页」describe 3 条（/hots 归一化、/ranks boards 字段、懒人 501）→ **5 文件 / 143 用例全绿**。
- 真实上游：`hotWords()` → 10 词；`rankBoards()` → 6 榜 × 10 专辑（经典免费榜榜首 30140766 辽沈晚报）。
- 懒人「本地」段删除后：懒人分段 = 历史/收藏两段；喜马拉雅不变（历史/声音/订阅/主播/专辑）。

## 17. 第十轮迭代（0.6.9）：分类榜单（喜马拉雅「小说→子分类」+ 懒人 3 张榜）

用户要求（m02982）：「喜马拉雅 /top/2/100168，抓取小说下面的分类，提供下拉菜单选分类后显示榜单内容；懒人 /discover/ranking?rankId=75，抓取左边分类做下拉后显示榜单内容」。两平台均声称「Top100」。

### 17.1 协议反向结论

**喜马拉雅（新分类树，需 `xm-sign` 签名）**：

- 分类树 `GET /revision/rank/v4/rankTabs?sceneId=1` + `xm-sign: getXmSign()` → 19 个一级分类（全站/小说/相声评书/儿童/有声图书/人文国学/历史/悬疑/娱乐/音乐/个人成长/生活/健康/商业财经/外语/热点/广播剧/播客/影视），每个分类的 `tabWraps[]` 就是子榜单。小说下 20 个：热播(100168)/完结(100180)/快更(100749)/潜力(100910)/新品(100157)/免费(100224)/新势力(100912)/月票(100332)/男生(100330)/女生(100331)/都市(100078)/玄幻(100079)/悬疑(100080)/历史(100081)/科幻(100082)/游戏(100083)/现言(100084)/古言(100085)/幻言(100086)/悬爱(100449)。
- 榜单内容 `GET /revision/rank/v4/element?rankingId=<id>` + `xm-sign` → `rankList[0].albums`。**关键：不带 `pageNum` 时服务端返回完整榜单（count/ids/albums 都是 100 条，网页版 /top 页就是这么调的）；一旦带 `pageNum`，它变成「返回条数」且硬上限 10**（实测 1→1、2→2、…10→10、11~200→都 10）。第一版实现误把 `pageNum` 当必填并默认 10，导致只拿到 Top10——已修正为「不传 pageNum 就返回 Top100」。旧版 `getCategoryRankPage?code=` 有 100 条但只有 22 个老分类（无「小说」），`getRankAlbum?rankIds=` 也固定 10 条。**⇒ 喜马拉雅新分类榜单可取完整 Top100**。

**懒人听书（匿名可用）**：

- 分类 = 榜单本身。`GET /api/ranking/resList?rankId=<id>` 匿名 200，返回 `list` 100 条 + `filterTypeList`（全部热播/新书热播）+ `timeRankList`（小时/日/周/月/总）。**只有 3 张榜活着**：75 热播榜、76 好评榜、77 热搜榜（各 100 条）。侧栏其余 5 张（新书/收藏/完结/免费/会员）接口已下线（`status:2「榜单已下线」`，扫描 60~120 其余 rankId 全 status=2）。`groupList` 返回空。`filterType/tab/type/channel/groupId/pageNo` 均不影响返回内容。**⇒ 懒人下拉 = 3 张榜 × Top100**。

### 17.2 实现

- `lib/xmly.js`：修 `normalizeRankAlbumDoc` 的 cover 改用 `normalizeCover()`（原实现把裸路径 `group72/...` 拼成 `https:group72/...`，是坏的）；新增 `V4_HEADERS()`（`referer /top` + `xm-sign`）、`rankTabs()`、`rankElement(rankingId, pageNum)`（pageNum 可选：不传返回完整 Top100，传了夹 1..10 作「返回条数」）。
- `lib/providers/ximalaya.js`：`rankCats()`/`rankContent(rankingId, pageNum)` 转发。
- `lib/providers/lrts.js`：`RANK_BOARDS` 常量（75/76/77）；`supports.ranks=true`；`rankCats()`（不触网，返回 3 榜）；`rankContent(rankingId)`（`/api/ranking/resList` → `toAlbum` + `playCount=hot`，未知榜 id → `BAD_ARGS` 400）。
- `lib/providers/index.js`：契约注释补 `rankCats()`/`rankContent(rankingId[, pageNum])`。
- `lib/index.js`：新增 `GET /dsh-tingbar/rank/cats`（返回分类树）、`GET /dsh-tingbar/rank/content?cat=<rankingId>&pageNum=`（返回单榜内容，缺 cat → 400）；`/ranks`（无参混排榜）保留不变（懒人仍 501，因为懒人没有「多榜混排」概念）。
- `lib/client.js`：搜索页「📈 榜单」改为**分类下拉 + 子榜单下拉 + 榜单内容列表**（名次徽标，Top3 高亮，专辑卡片点击进详情）。喜马拉雅两级下拉（一级分类 → 子榜单），懒人单级下拉（榜单）。**懒人未登录时也能浏览榜单**（榜单接口匿名可用，抽成 `rankToggleBtn`/`rankBoard` 局部，登录闸门下也渲染）。状态 `rankCats/rankCat1/rankCat2/rankContent`，`switchPlatform` 重置。

### 17.3 验证

- 单测：`test/index.test.js` mock `rankTabs`/`rankElement`，新增「分类榜单」describe 5 条（/rank/cats 分类树、/rank/content 归一化、缺 cat 400、懒人 3 榜、懒人未知榜 400）；`test/lrts.test.js` 新增 rankCats/rankContent 3 条（不触网 + 归一化 + 未知榜 BAD_ARGS）→ **5 文件 / 151 用例全绿**。
- 真实上游冒烟：`rankTabs()` → 19 分类（小说 20 子榜）；`rankElement(100168)` → 小说热播榜 **100 张专辑**（0.6.10 修正后不带 pageNum 返回完整榜），封面正确落到 `https://imagev2.xmcdn.com/storages/...`（normalizeCover 修复生效）；`lrtsProvider.rankContent(75)` → 热播榜 100 张专辑（榜首「道士不好惹」，`playCount=624902601`，封面 `https://bookpic.lrts.me/...`）。

### 17.4 遗留

- 喜马拉雅 Top100 已可获取（0.6.10 修正：不传 `pageNum` 即返回完整榜单）；懒人 5 张下线榜仍无解（上游下线）。
- 懒人 `resList` 的 `filterTypeList`（全部热播/新书热播）与 `timeRankList`（小时/日/周/月/总）未做二级筛选——实测这些参数不影响返回内容，暂不实现。

## 18. 第十一轮迭代（0.6.11）：懒人听书榜单全量（纠正「只有 3 张榜」）

用户纠正（m03909）：「懒人的所有榜单，都可以正常显示 Top100，并不是只有三张榜是正常的」。

### 18.1 根因

17.1 里「懒人只有 3 张榜」是**探测方法错误**：当时只扫了 `rankId 60~120` 区间，撞见 75/76/77 三张，就把区间内其余的 `status:2「榜单已下线」` 当成「其余 5 张下线」。实际上懒人侧栏其余榜的 `rankId`（畅销 265、新书 738、完结 739、会员 740、收藏 14479、免费 14481）**根本不在 60~120 区间**，从没被探测过。

从懒人前端 chunk `Bo9MKgC0.js` 逆向出正确协议：

- 榜单页侧栏由 `GET /api/ranking/groupList?groupId=0&groupType=1` 提供（之前无参调用返回空 list 所以误判）。
- 内容请求 `GET /api/ranking/resList?rankId=<id>&rangeType=3(=总榜)&pageSize=100`。
- 分组结构：`He(e,t)` = `e===k(6) ? announcerList(t) : resList(t)` —— `rankType 6` 是主播榜（走 `announcerList`），其余是书籍/专辑榜（走 `resList`）。

实时探测：`groupList` 返回 **5 个分组 / 34 张榜**（全部 9、出版 9、儿童 5、节目 7、主播 4）。9 张「全部」榜用 `resList?rangeType=3&pageSize=100` 实测全部返回 Top100（免费榜 98 条，其余 100）。

### 18.2 实现

- `lib/providers/lrts.js`：`RANK_BOARDS`（3 条）改为 `RANK_FALLBACK`（「全部」组 9 条：75/265/738/77/76/14479/739/14481/740，作 groupList 拉不到时的兜底）；`rankCats()` 改为动态拉 `groupList`（`groupId=0&groupType=1`），每组 `rankingsGroupInfoView.name` → tab、`rankingsList` 里 `rankType===0 && rankId>0` → wraps，过滤空组；失败 catch 落到 `RANK_FALLBACK` 单组「排行榜」。`rankContent(rankingId)` 删掉硬编码 3 榜校验，改调 `resList` 带 `rangeType=3&pageSize=100`，`data.list` → `toAlbum` + `playCount=hot`；只保留「非法 id → BAD_ARGS 400」。
- `lib/providers/index.js`：契约注释同步（懒人动态 groupList，只保留 rankType 0，主播榜 rankType 6 不纳入）。
- `lib/index.js`：路由注释同步（两平台都是 Top100）。
- `lib/client.js`：无需改动——`rankBoard` 的 `hasTwoLevel` 逻辑本就支持「分组 → 榜单」两级下拉，懒人现在从单级自动变成两级。

### 18.3 验证

- 单测：`test/lrts.test.js` 重写 3 条为 5 条（groupList 解析 + 过滤主播榜 rankType 6、拉取失败回退 9 榜、rangeType=3/pageSize=100 断言、非法 id BAD_ARGS 不触网、未知榜服务端 status:2 → API_RET 502）；`test/index.test.js` 新增 `vi.mock('../lib/providers/lrts.js')`（只 mock rankCats/rankContent，其余走真实实现），两条懒人用例改为「分组榜单树」「榜单内容归一化」→ **5 文件 / 154 用例全绿**。
- 真实上游冒烟：`rankCats()` → 4 组（全部 9/出版 9/儿童 5/节目 6 = 29 张 rankType 0 榜，主播组被过滤）；`rankContent(738)` → 新书榜 100 张（榜首「鬼吹灯第1-8册」，playCount 489037）；`rankContent(14481)` → 免费榜 98 张。

### 18.4 遗留

- 主播榜（rankType 6）未纳入：内容是播主排行（`announcerList` 接口），与「听书榜单」不同；插件已有独立的「主播」tab 可浏览主播。
- 喜马拉雅 Top100 在 0.6.10 已修好（不传 `pageNum` 返回完整榜单），本轮未再改动。


## 19. 第十二轮迭代（0.6.12）：播放条移到左侧栏底部

用户发来一张纯截图（无文字），箭头从聊天输入框上方的播放条指向左侧栏空白区，经确认意图是「把播放条移到侧栏底部（设置旁边）」。

### 19.1 槽位探查结论

DSH 的 Web 框架里，底部播放条原来注册在 `conversation.input.dock`（输入框上方）。侧栏列由 `dsh-client-ui-layout` 的 `AppFrame.tsx` 渲染，侧栏内部是 `dsh-client-ui-sidebar` 的固定组合（品牌行 + New Session + 全局面板行 + `sidebar.workspaces` + `sidebar.settings`），**没有「侧栏顶部空白区」的公开 list 槽位**；唯一可注入的位置是脚部的 list 槽位 `sidebar.footer.action`（渲染在设置按钮上方，owner props 为 `{ wide: boolean }`，`wide=true` 表示侧栏展开、`false` 表示 56px 竖条）。参考实现：`dsh-client-ui-cordis` 的 `CordisPanel`。

### 19.2 实现

- `lib/client.js`：`NowPlayingBar` 改为接收 `props`（`const wide = !props || props.wide !== false`），`wide=false` 时渲染单图标 `.xmly-rail-btn`（▶/⏸），`wide=true` 时渲染竖排布局（标题行 → 五键控制 → 时间/音量/倍速/搜索）；注入从 `conversation.input.dock` 改为 `sidebar.footer.action`（id `ximalaya-player`），组件注册为 `(props) => React.createElement(NowPlayingBar, props)` 以便收到 `{ wide }`。`shell.overlay` 面板注入不变。
- CSS：`.xmly-bar` 改纵向 flex，新增 `.xmly-bar-head`/`.xmly-bar-meta`/`.xmly-rail`/`.xmly-rail-btn`。
- 测试：`test/client.test.js` 全部 `conversation.input.dock` 引用替换为 `sidebar.footer.action`，新增折叠态（`wide=false`）用例；**5 文件 / 155 用例全绿**。
- 版本 0.6.12。

### 19.3 遗留

- 折叠态（竖条）只给了一个图标按钮，展开后才能看到完整控制键；这是侧栏槽位 `{ wide }` 的固有形态。

### 19.4 位置纠正（0.6.13）：排到「导入会话」正上方

0.6.12 首次落地时，播放条与「导入会话」入口都注册在 `sidebar.footer.action`（`dsh-chat-import` 插件的 `ImportButton`，`order: 0`），但播放条未设 `order`，被排在「导入会话」下方——与用户真正要的「位于导入会话正上方」相反。

- 定位结论：「导入会话」全宽按钮来自 `dsh-chat-import`（`lib/client.js`），`ctx.slots.register({ name: 'sidebar.footer.action', id: 'chat-import', order: 0 }, ImportButton)`；同槽 list 按 `order` **升序**堆叠（`dsh-client-ui-renderer` 契约：`order` 为「ascending; registration order otherwise」）。
- 修法：`lib/client.js` 播放条注册项加 `order: -1`（低于 chat-import 的 `order: 0`），即可排到「导入会话」上方；功能、内容、其它侧栏项均不变。
- 真机验证（UIA）：最终侧栏底部垂直顺序 = 播放条（y≈1847）→ 导入会话（y≈1980）→ 账号菜单（y≈2049）。提交 `2afa92c`。


