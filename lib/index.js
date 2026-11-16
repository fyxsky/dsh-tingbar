/**
 * lib/index.js — 听说播放器（喜马拉雅 / 懒人听书）host 半边。
 *
 * 职责：
 *   - 在 DSH webServer 上挂载 /dsh-tingbar/* 路由：搜索/专辑/曲目/播放地址/
 *     音频流式代理（Range 续传）/扫码登录/用户信息/已关注主播/收藏的声音/
 *     主播公开专辑/偏好与收藏持久化/播放意图。
 *   - 平台维度：所有路由接受 ?platform=ximalaya|lrts（缺省取 prefs.platform，
 *     再缺省 ximalaya）；协议差异收敛在 lib/providers/*，本文件只做调度。
 *   - 注册 ximalaya_play 模型工具（agent 可按关键词搜索并播放，含 platform 参数）。
 *   - 注入一段 system prompt，让 agent 知道本机可听喜马拉雅与懒人听书。
 *
 * 登录态（cookie）、收藏、播放进度、搜索历史按平台隔离持久化在 Host 端
 * ~/.dsh/tingbar-state.json（v2 结构，旧版自动迁移）。
 *
 * 浏览器半边（lib/client.js）只通过本模块的 HTTP 路由交互，不直接触碰上游接口
 * （避免 CORS 与登录态暴露）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { Readable } from 'node:stream'
import {
  PROVIDERS,
  PLATFORM_IDS,
  DEFAULT_PLATFORM,
  isPlatform,
  providerOf,
  platformsMeta,
  labelOf,
} from './providers/index.js'

export const name = 'dsh-tingbar'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt']

// 播放地址缓存：`platform:trackId` → { url, quality, title, expiresAt }。
// CDN 直链通常长期有效，但保守 10 分钟过期；账号态解密地址同理。
const PLAY_TTL = 10 * 60 * 1000

// 偏好里允许持久化的键（白名单，防止客户端把任意字段写进状态文件）。
// seekStep：浏览器侧快进/快退按钮的跳转步长（秒），客户端默认 15。
// platform：上次选中的平台，刷新后恢复。
const PREF_ALLOW = new Set([
  'volume', 'rate', 'seekStep', 'playback', 'panelPos', 'panelOpen', 'quality', 'platform',
])

const emptyAccount = () => ({ cookie: {}, user: null, updatedAt: 0 })

export function apply(ctx) {
  let home = null
  let state = null
  let stateLoaded = false
  let pendingIntent = null // 播放意图（客户端轮询即取即焚）
  // 远程诊断：Web 端把播放/跳转的现场数据回报上来（只保留最近 40 条），
  // 以及「让 Web 端执行一次指定操作」的一次性指令（排查 real bug 用，不影响正常流程）。
  const diagLog = []
  let diagCmd = null
  const streamLog = []
  const playCache = new Map()
  // 每个平台独立的扫码会话
  const qrSessions = Object.fromEntries(PLATFORM_IDS.map((id) => [id, null]))
  const userRefreshing = new Map()

  // ---- home / state persistence（直接用 node:fs，绕开 ctx.fs 工作区围栏）----
  const getHome = async () => {
    if (home !== null) return home
    try {
      const osHome = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
      if (osHome !== '') { home = osHome; return home }
    } catch { /* fall through to shell */ }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf %s "$HOME"' }))
      const value = String((result.stdout && result.stdout.text) || '').trim()
      home = value || null
    } catch {
      home = null
    }
    return home
  }
  const stateFile = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/tingbar-state.json'
  }

  const sanitizeFavs = (list) => (Array.isArray(list)
    ? list.filter((f) => f && typeof f === 'object' && typeof f.id !== 'undefined').slice(0, 200)
    : [])
  const sanitizeHistory = (list) => (Array.isArray(list)
    ? list.filter((x) => typeof x === 'string' && x !== '').slice(0, 20)
    : [])

  /** v1（单平台扁平结构）→ v2（多平台分槽）。 */
  const migrate = (saved) => {
    const version = Number(saved.version) || 1
    if (version >= 2) {
      const accounts = {}
      for (const id of PLATFORM_IDS) {
        const a = (saved.accounts && saved.accounts[id]) || {}
        accounts[id] = {
          cookie: (a.cookie && typeof a.cookie === 'object') ? a.cookie : {},
          user: (a.user && typeof a.user === 'object') ? a.user : null,
          updatedAt: Number(a.updatedAt) || 0,
        }
      }
      const favs = {}
      const history = {}
      const playback = {}
      for (const id of PLATFORM_IDS) {
        favs[id] = sanitizeFavs(saved.favs && saved.favs[id])
        history[id] = sanitizeHistory(saved.history && saved.history[id])
        playback[id] = (saved.playback && typeof saved.playback[id] === 'object' && saved.playback[id]) || {}
      }
      return {
        version: 2,
        accounts,
        prefs: (saved.prefs && typeof saved.prefs === 'object') ? saved.prefs : {},
        favs,
        history,
        playback,
      }
    }
    // v1：把老结构整体搬进 ximalaya 槽。
    const favs = {}
    const history = {}
    const playback = {}
    for (const id of PLATFORM_IDS) {
      favs[id] = id === DEFAULT_PLATFORM ? sanitizeFavs(saved.favs) : []
      history[id] = id === DEFAULT_PLATFORM ? sanitizeHistory(saved.history) : []
      playback[id] = id === DEFAULT_PLATFORM && saved.playback && typeof saved.playback === 'object' ? saved.playback : {}
    }
    const accounts = {}
    for (const id of PLATFORM_IDS) {
      accounts[id] = id === DEFAULT_PLATFORM
        ? {
            cookie: (saved.cookie && typeof saved.cookie === 'object') ? saved.cookie : {},
            user: (saved.user && typeof saved.user === 'object') ? saved.user : null,
            updatedAt: 0,
          }
        : emptyAccount()
    }
    return {
      version: 2,
      accounts,
      prefs: (saved.prefs && typeof saved.prefs === 'object') ? saved.prefs : {},
      favs,
      history,
      playback,
    }
  }

  const loadState = async () => {
    if (stateLoaded) return state
    stateLoaded = true
    const file = await stateFile()
    let saved = {}
    if (file !== null && existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8')
        if (text.trim()) saved = JSON.parse(text)
      } catch { saved = {} }
    }
    state = migrate(saved)
    // 后台校验各平台登录态：cookie 失效时清掉 user（不阻塞请求）。
    for (const id of PLATFORM_IDS) void refreshUser(id)
    return state
  }
  const saveState = async () => {
    if (state === null) return
    const file = await stateFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      // 持久化尽力而为：写不进只丢记忆，不影响播放。
    }
  }
  const ensureState = async () => { if (!stateLoaded) await loadState(); return state }

  // ---- 平台与账号 ----
  const currentPlatform = () => {
    const p = state && state.prefs ? state.prefs.platform : null
    return isPlatform(p) ? p : DEFAULT_PLATFORM
  }
  /** 解析请求里的平台：显式非法 → null（调用方回 400）；缺省 → 当前平台。 */
  const platformFrom = (url) => {
    const raw = url.searchParams.get('platform')
    if (raw === null || raw === '') return currentPlatform()
    return isPlatform(raw) ? raw : null
  }
  const accountOf = (platform) => {
    if (!state.accounts[platform]) state.accounts[platform] = emptyAccount()
    return state.accounts[platform]
  }
  const cookieOf = (platform) => {
    const provider = providerOf(platform)
    return provider.joinCookies(accountOf(platform).cookie)
  }
  const userOf = (platform) => accountOf(platform).user
  const loggedIn = (platform) => {
    const user = userOf(platform)
    return !!user && !!user.nickname && cookieOf(platform) !== ''
  }

  const refreshUser = async (platform) => {
    if (userRefreshing.has(platform)) return userRefreshing.get(platform)
    const task = (async () => {
      try {
        await loadState()
        const header = cookieOf(platform)
        const account = accountOf(platform)
        if (header === '') { account.user = null; return null }
        const user = await providerOf(platform).user(header)
        account.user = user
        if (user !== null) account.updatedAt = Date.now()
        await saveState()
        return user
      } catch {
        return accountOf(platform).user
      } finally {
        userRefreshing.delete(platform)
      }
    })()
    userRefreshing.set(platform, task)
    return task
  }

  // ---- play URL 解析（带缓存，按平台隔离）----
  async function resolvePlayCached(platform, params) {
    await ensureState()
    // 懒人听书的 tmeId 才是真正的播放资源号，必须进缓存键。
    const key = platform + ':' + String(params.trackId) + (params.tmeId ? ':' + String(params.tmeId) : '')
    const hit = playCache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit
    const resolved = await providerOf(platform).resolvePlay({ ...params, cookie: cookieOf(platform) })
    const entry = { ...resolved, expiresAt: Date.now() + PLAY_TTL }
    playCache.set(key, entry)
    return entry
  }

  // ---- 播放意图（agent 工具 → 浏览器）----
  const takeIntent = () => {
    const intent = pendingIntent
    pendingIntent = null
    return intent
  }

  // ---- HTTP helpers ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  const fail = (res, platform, err) => {
    const info = providerOf(platform).errorInfo(err)
    writeJson(res, {
      ok: false,
      error: info.message,
      needLogin: info.needLogin,
      needVip: info.needVip,
    }, info.status)
  }
  const unsupported = (res, platform, what) => writeJson(res, {
    ok: false, unsupported: true,
    error: labelOf(platform) + '暂不支持' + what,
  }, 501)

  const platformSummary = () => PLATFORM_IDS.map((id) => {
    const user = userOf(id)
    return {
      id,
      label: labelOf(id),
      loggedIn: loggedIn(id),
      nickname: (user && user.nickname) || '',
      isVip: !!(user && user.isVip),
      vipLevel: (user && Number(user.vipLevel)) || 0,
      vipDays: (user && Number(user.vipDays)) || 0,
      vipUntil: (user && Number(user.vipUntil)) || 0,
    }
  })

  const publicState = (platform) => ({
    ok: true,
    platform,
    platformLabel: labelOf(platform),
    platforms: platformsMeta(),
    accounts: platformSummary(),
    loggedIn: loggedIn(platform),
    user: userOf(platform),
    prefs: state.prefs,
    favs: state.favs[platform].slice(0, 200),
    history: state.history[platform].slice(0, 20),
    playback: state.playback[platform],
  })

  // ---- 回环音频源：dsh-app:// 自定义协议下 <audio> 的 seekable 恒为 [[0,0]]（不可 seek），
  // 换成 127.0.0.1 上的普通 http 源后 Chromium 才走正常的 Range 媒体管线。 ----
  let audioServer = null
  let audioBase = ''
  async function ensureAudioServer() {
    if (audioServer !== null && audioBase !== '') return audioBase
    // 只有本机进程能连这个口，但 loopback 对本机任何进程都开放，
    // 所以路径里塞一段随机 token，避免被别的程序白嫖付费音频。
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const u = new URL(req.url || '/', 'http://127.0.0.1')
          const segs = u.pathname.split('/').filter((s) => s !== '')
          if (segs[0] !== token || segs[1] !== 'stream') { res.writeHead(404); res.end(); return }
          const wanted = u.searchParams.get('platform') || DEFAULT_PLATFORM
          const target = isPlatform(wanted) ? wanted : DEFAULT_PLATFORM
          const trackId = u.searchParams.get('trackId') || ''
          if (trackId === '') { res.writeHead(400); res.end(); return }
          await relayAudio(req, res, target, {
            trackId,
            albumId: u.searchParams.get('albumId') || '',
            section: u.searchParams.get('section'),
            tmeId: u.searchParams.get('tmeId') || '',
          })
        } catch (err) {
          try { res.writeHead(500); res.end(String((err && err.message) || err)) } catch (e2) { /* 已断开 */ }
        }
      })()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    audioServer = server
    const addr = server.address()
    audioBase = 'http://127.0.0.1:' + String((addr && addr.port) || 0) + '/' + token
    return audioBase
  }
  function closeAudioServer() {
    if (audioServer !== null) {
      try { audioServer.close() } catch (e) { /* ignore */ }
      audioServer = null
      audioBase = ''
    }
  }

  // ---- 音频流代理：转发 Range，流式 pipe，上游 403/404 时重取一次直链 ----
  async function relayAudio(req, res, platform, params) {
    const provider = providerOf(platform)
    const upstreamHeaders = { ...provider.streamHeaders() }
    const forward = (h) => (typeof req.headers[h] === 'string' ? req.headers[h] : undefined)
    if (forward('range')) upstreamHeaders.range = forward('range')

    const fetchUpstream = async (url) => fetch(url, {
      headers: upstreamHeaders,
      redirect: 'follow',
    })

    let resolved
    try {
      resolved = await resolvePlayCached(platform, params)
    } catch (err) {
      fail(res, platform, err)
      return
    }
    let upstream = await fetchUpstream(resolved.url)
    // 直链可能刚过期（403/404）：清缓存重取一次再试。
    if (upstream.status === 403 || upstream.status === 404) {
      playCache.delete(platform + ':' + String(params.trackId) + (params.tmeId ? ':' + String(params.tmeId) : ''))
      try {
        resolved = await resolvePlayCached(platform, params)
      } catch (err) {
        fail(res, platform, err)
        return
      }
      upstream = await fetchUpstream(resolved.url)
    }

    if (!upstream.ok && upstream.status !== 206) {
      try { upstream.body && await upstream.body.cancel() } catch {}
      writeJson(res, { ok: false, error: '音频源返回 HTTP ' + upstream.status }, 502)
      return
    }

    const headers = {
      'content-type': upstream.headers.get('content-type') || provider.mime || 'audio/x-m4a',
      'cache-control': 'no-store',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
      // 走 127.0.0.1 回环口时才需要（页面源是 dsh-app://app，跨源放行）。
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, content-length, accept-ranges',
    }
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h)
      if (v) headers[h] = v
    }
    res.writeHead(upstream.status, headers)
    streamLog.push({
      at: Date.now(),
      kind: 'resp',
      status: upstream.status,
      range: String(req.headers.range || ''),
      contentRange: String(headers['content-range'] || ''),
      contentLength: String(headers['content-length'] || ''),
      acceptRanges: String(headers['accept-ranges'] || ''),
    })
    if (streamLog.length > 30) streamLog.shift()
    if (req.method === 'HEAD') {
      try { upstream.body && await upstream.body.cancel() } catch {}
      res.end()
      return
    }
    if (!upstream.body) { res.end(); return }
    await new Promise((resolve) => {
      const nodeStream = Readable.fromWeb(upstream.body)
      nodeStream.pipe(res)
      nodeStream.on('error', () => { try { res.end() } catch {} resolve() })
      res.on('close', () => { try { nodeStream.destroy() } catch {} resolve() })
      nodeStream.on('end', resolve)
    })
  }

  // ---- 路由 ----
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname
      await ensureState()
      const platform = platformFrom(url)
      if (platform === null) {
        writeJson(res, { ok: false, error: '未知平台（可用：' + PLATFORM_IDS.join(' / ') + '）' }, 400)
        return
      }
      const provider = providerOf(platform)

      // 初始清单：平台列表/登录态/收藏/历史/上次播放。
      if (pathname === '/dsh-tingbar/manifest' && req.method === 'GET') {
        writeJson(res, publicState(platform))
        return
      }

      // 平台列表（轻量，切换器首次渲染用）。
      if (pathname === '/dsh-tingbar/platforms' && req.method === 'GET') {
        writeJson(res, { ok: true, platform, platforms: platformsMeta(), accounts: platformSummary() })
        return
      }

      // 首页推荐（懒人听书匿名可得；喜马拉雅无此接口）。
      if (pathname === '/dsh-tingbar/home' && req.method === 'GET') {
        if (!provider.home) { unsupported(res, platform, '首页推荐'); return }
        try {
          const result = await provider.home(cookieOf(platform))
          writeJson(res, { ok: true, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 热搜词（喜马拉雅搜索框下拉同款，匿名可用）。
      if (pathname === '/dsh-tingbar/hots' && req.method === 'GET') {
        if (!provider.supports.hotWords || typeof provider.hotWords !== 'function') {
          unsupported(res, platform, '热搜词')
          return
        }
        try {
          const result = await provider.hotWords()
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 排行榜（喜马拉雅网页版 /ranking 同款，匿名可用）。
      if (pathname === '/dsh-tingbar/ranks' && req.method === 'GET') {
        if (!provider.supports.ranks || typeof provider.ranks !== 'function') {
          unsupported(res, platform, '排行榜')
          return
        }
        try {
          const result = await provider.ranks()
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 分类榜单：下拉数据源（喜马拉雅 19 分类 + 子榜单；懒人 groupList 分组 + 榜单）。
      if (pathname === '/dsh-tingbar/rank/cats' && req.method === 'GET') {
        if (!provider.supports.ranks || typeof provider.rankCats !== 'function') {
          unsupported(res, platform, '分类榜单')
          return
        }
        try {
          const result = await provider.rankCats()
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 分类榜单：单个榜单内容（两平台都是 Top100，匿名可用）。
      if (pathname === '/dsh-tingbar/rank/content' && req.method === 'GET') {
        if (!provider.supports.ranks || typeof provider.rankContent !== 'function') {
          unsupported(res, platform, '分类榜单')
          return
        }
        const cat = parseInt(url.searchParams.get('cat') || '', 10)
        if (!Number.isInteger(cat) || cat <= 0) { writeJson(res, { ok: false, error: '缺少榜单参数 cat' }, 400); return }
        try {
          // pageNum 可选：不传时服务端返回完整榜单（两平台都是 Top100）。
          const raw = url.searchParams.get('pageNum')
          const pageNum = raw === null || raw === '' ? undefined : parseInt(raw, 10)
          const result = await provider.rankContent(cat, pageNum)
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 搜索专辑（顺便记录搜索历史）。
      if (pathname === '/dsh-tingbar/search' && req.method === 'GET') {
        const kw = (url.searchParams.get('kw') || '').trim()
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        if (kw === '') { writeJson(res, { ok: false, error: '缺少关键词' }, 400); return }
        try {
          const result = await provider.search(kw, page, 20, cookieOf(platform))
          if (page === 1 && result.albums.length > 0) {
            state.history[platform] = [kw, ...state.history[platform].filter((x) => x !== kw)].slice(0, 20)
            void saveState()
          }
          writeJson(res, { ok: true, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 专辑详情。
      if (pathname === '/dsh-tingbar/album' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        try {
          const album = await provider.album(id, cookieOf(platform))
          writeJson(res, { ok: true, album })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 专辑曲目列表（分页）。
      if (pathname === '/dsh-tingbar/tracks' && req.method === 'GET') {
        const albumId = url.searchParams.get('albumId') || ''
        const pageId = Math.max(1, parseInt(url.searchParams.get('pageId') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(10, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        // force=1：绕过 provider 的目录缓存（用户手动刷新目录时用）。
        const force = url.searchParams.get('force') === '1'
        try {
          const result = await provider.tracks({ albumId, pageId, pageSize, cookie: cookieOf(platform), force })
          writeJson(res, { ok: true, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 上一集 / 下一集：由 Host 在完整目录里定位相邻章节。
      // 客户端只加载了专辑第 1 页，从历史/搜索直接起播时（比如第 800 集）那一页
      // 里根本没有当前章节，纯前端算不出「下一集」。
      if (pathname === '/dsh-tingbar/neighbor' && req.method === 'GET') {
        const albumId = url.searchParams.get('albumId') || ''
        const trackId = url.searchParams.get('trackId') || ''
        const section = url.searchParams.get('section')
        const dir = url.searchParams.get('dir') === '-1' ? -1 : 1
        if (albumId === '') { writeJson(res, { ok: false, error: '缺少 albumId' }, 400); return }
        if (typeof provider.neighbor !== 'function') { unsupported(res, platform, '上一集/下一集'); return }
        try {
          const out = await provider.neighbor({
            albumId, trackId, section, dir, cookie: cookieOf(platform),
          })
          writeJson(res, {
            ok: true, platform, dir,
            track: out.track || null, index: out.index, total: out.total || 0,
          })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 解析播放地址（JSON，调试/预取用；正式播放走 /stream）。
      if (pathname === '/dsh-tingbar/play' && req.method === 'GET') {
        const trackId = url.searchParams.get('trackId') || ''
        if (trackId === '') { writeJson(res, { ok: false, error: '缺少 trackId' }, 400); return }
        const albumId = url.searchParams.get('albumId') || ''
        const section = url.searchParams.get('section')
        // 懒人听书的播放资源号（tmeId）和章节 id 不是一个东西，必须原样带下去。
        const tmeId = url.searchParams.get('tmeId') || ''
        try {
          const resolved = await resolvePlayCached(platform, { trackId, albumId, section, tmeId })
          let streamUrl = '/dsh-tingbar/stream?trackId=' + encodeURIComponent(trackId)
          if (platform !== DEFAULT_PLATFORM) streamUrl += '&platform=' + encodeURIComponent(platform)
          if (albumId !== '') streamUrl += '&albumId=' + encodeURIComponent(albumId)
          if (section !== null && section !== '') streamUrl += '&section=' + encodeURIComponent(section)
          if (tmeId !== '') streamUrl += '&tmeId=' + encodeURIComponent(tmeId)
          writeJson(res, {
            ok: true,
            platform,
            trackId: /^\d+$/.test(trackId) ? Number(trackId) : trackId,
            quality: resolved.quality,
            source: resolved.source,
            title: resolved.title,
            duration: resolved.duration,
            streamUrl,
          })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 回环音频源的基址（浏览器用它拼 <audio> 的 src，避开不可 seek 的 dsh-app://）。
      if (pathname === '/dsh-tingbar/audio-origin' && req.method === 'GET') {
        try {
          const base = await ensureAudioServer()
          writeJson(res, { ok: true, base })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }

      // 音频流代理（<audio> 的 src 指向这里；Range/seek 透传）。
      if (pathname === '/dsh-tingbar/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
        const trackId = url.searchParams.get('trackId') || ''
        if (trackId === '') { res.writeHead(400); res.end(); return }
        // 诊断：记录每次取流请求的 Range，用来判断「浏览器到底有没有发出带区间的请求」。
        streamLog.push({
          at: Date.now(),
          method: req.method,
          trackId,
          range: String(req.headers.range || ''),
          ifRange: String(req.headers['if-range'] || ''),
        })
        if (streamLog.length > 30) streamLog.shift()
        await relayAudio(req, res, platform, {
          trackId,
          albumId: url.searchParams.get('albumId') || '',
          section: url.searchParams.get('section'),
          tmeId: url.searchParams.get('tmeId') || '',
        })
        return
      }

      // 扫码登录：创建二维码（平台由 ?platform 或 body.platform 决定）。
      if (pathname === '/dsh-tingbar/qr/create' && req.method === 'POST') {
        const body = await readBody(req)
        let target = platform
        if (body && typeof body.platform === 'string' && body.platform !== '') {
          if (!isPlatform(body.platform)) { writeJson(res, { ok: false, error: '未知平台' }, 400); return }
          target = body.platform
        }
        try {
          const session = await providerOf(target).qrCreate()
          qrSessions[target] = session
          writeJson(res, {
            ok: true, platform: target,
            qrId: session.qrId, sceneToken: session.sceneToken,
            imageDataUrl: session.imageDataUrl,
            expiresAt: session.expiresAt,
            hint: session.hint || providerOf(target).qrHint,
          })
        } catch (err) { fail(res, target, err) }
        return
      }
      // 扫码登录：轮询结果（成功即落盘 cookie + user）。
      if (pathname === '/dsh-tingbar/qr/check' && req.method === 'GET') {
        const session = qrSessions[platform]
        const token = url.searchParams.get('qrId') || url.searchParams.get('sceneToken') || ''
        if (session === null || session === undefined) {
          writeJson(res, { ok: false, error: '二维码未创建' }, 400); return
        }
        const sessionId = String(session.qrId || session.sceneToken || '')
        if (token === '' || token !== sessionId) {
          writeJson(res, { ok: false, error: '二维码已刷新，请重新打开' }, 400); return
        }
        try {
          const result = await providerOf(platform).qrCheck(session)
          if (result.status === 'success' && result.cookies) {
            accountOf(platform).cookie = result.cookies
            accountOf(platform).updatedAt = Date.now()
            for (const key of [...playCache.keys()]) {
              if (key.startsWith(platform + ':')) playCache.delete(key)
            }
            const user = await refreshUser(platform)
            qrSessions[platform] = null
            await saveState()
            writeJson(res, { ok: true, platform, status: 'success', user: user || { nickname: '' } })
          } else if (result.status === 'expired') {
            qrSessions[platform] = null
            writeJson(res, { ok: true, platform, status: 'expired' })
          } else {
            writeJson(res, { ok: true, platform, status: 'waiting' })
          }
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 手工导入 cookie（扫码被风控/失败时的兜底）。
      if (pathname === '/dsh-tingbar/login/cookie' && req.method === 'POST') {
        const body = await readBody(req)
        const target = body && isPlatform(body.platform) ? body.platform : platform
        const raw = body && typeof body.cookie === 'string' ? body.cookie.trim() : ''
        if (raw === '') { writeJson(res, { ok: false, error: '缺少 cookie 字符串' }, 400); return }
        const map = {}
        for (const part of raw.split(';')) {
          const eq = part.indexOf('=')
          if (eq <= 0) continue
          const k = part.slice(0, eq).trim()
          const v = part.slice(eq + 1).trim()
          if (k !== '') map[k] = v
        }
        if (Object.keys(map).length === 0) { writeJson(res, { ok: false, error: 'cookie 格式无法解析' }, 400); return }
        accountOf(target).cookie = map
        accountOf(target).updatedAt = Date.now()
        const user = await refreshUser(target)
        await saveState()
        writeJson(res, { ok: true, platform: target, loggedIn: !!user, user })
        return
      }

      // 用户信息（强制刷新）。
      if (pathname === '/dsh-tingbar/user' && req.method === 'GET') {
        const user = await refreshUser(platform)
        writeJson(res, { ok: true, platform, loggedIn: !!user, user })
        return
      }
      // 退出登录（只清当前平台）。
      if (pathname === '/dsh-tingbar/logout' && req.method === 'POST') {
        accountOf(platform).cookie = {}
        accountOf(platform).user = null
        accountOf(platform).updatedAt = Date.now()
        if (provider.logout) { try { await provider.logout() } catch { /* 忽略 */ } }
        for (const key of [...playCache.keys()]) {
          if (key.startsWith(platform + ':')) playCache.delete(key)
        }
        await saveState()
        writeJson(res, { ok: true, platform })
        return
      }

      // 偏好读写（音量/倍速/面板位置/上次播放/当前播放快照/当前平台）。
      if (pathname === '/dsh-tingbar/prefs' && req.method === 'GET') {
        writeJson(res, { ok: true, platform, prefs: state.prefs, playback: state.playback[platform] })
        return
      }
      if (pathname === '/dsh-tingbar/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        const patch = (body && body.prefs && typeof body.prefs === 'object') ? body.prefs : {}
        for (const [k, v] of Object.entries(patch)) {
          if (!PREF_ALLOW.has(k)) continue
          if (k === 'platform' && !isPlatform(v)) continue
          state.prefs[k] = v
        }
        if (body && body.playback && typeof body.playback === 'object') {
          const pb = body.playback
          const prev = state.playback[platform] || {}
          state.playback[platform] = {
            albumId: typeof pb.albumId === 'number' ? pb.albumId : prev.albumId,
            albumTitle: typeof pb.albumTitle === 'string' ? pb.albumTitle : '',
            trackId: typeof pb.trackId === 'number' ? pb.trackId : null,
            trackTitle: typeof pb.trackTitle === 'string' ? pb.trackTitle : '',
            // 懒人听书解析播放地址要章节序号（section），刷新后恢复播放依赖它。
            section: Number.isFinite(pb.section) ? pb.section : prev.section,
            position: Number.isFinite(pb.position) ? Math.max(0, pb.position) : 0,
            duration: Number.isFinite(pb.duration) ? Math.max(0, pb.duration) : 0,
            cover: typeof pb.cover === 'string' ? pb.cover : (prev.cover || ''),
            updatedAt: Date.now(),
          }
        }
        await saveState()
        writeJson(res, { ok: true, platform, prefs: state.prefs, playback: state.playback[platform] })
        return
      }

      // 云端收听历史：喜马拉雅「我的→听过」、懒人听书「我的→收听记录」。
      // 两端都要求登录态，且都是账号级数据（手机端听过的也会出现在这里）。
      if (pathname === '/dsh-tingbar/listened' && req.method === 'GET') {
        const provider = providerOf(platform)
        if (!provider.supports.cloudHistory || typeof provider.listened !== 'function') {
          unsupported(res, platform, '收听历史')
          return
        }
        if (!loggedIn(platform)) {
          writeJson(res, { ok: false, platform, needLogin: true, message: `查看${labelOf(platform)}收听历史需要先扫码登录` }, 401)
          return
        }
        try {
          const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
          const pageNum = Math.max(1, parseInt(url.searchParams.get('pageNum') || '1', 10) || 1)
          const referId = url.searchParams.get('referId') || ''
          const data = await provider.listened(cookieOf(platform), { pageNum, pageSize, referId })
          writeJson(res, {
            ok: true,
            platform,
            pageNum,
            referId: data.referId || '',
            totalCount: Number(data.totalCount) || (Array.isArray(data.items) ? data.items.length : 0),
            // provider 的翻页尽头判定（懒人听书按 referId 游标；喜马拉雅上游不翻页恒 false）。
            hasMore: data.hasMore === true,
            items: Array.isArray(data.items) ? data.items : [],
          })
        } catch (err) {
          fail(res, platform, err)
        }
        return
      }

      // 云端收藏（懒人听书；喜马拉雅对应能力是「收藏的声音」/likes）。
      if (pathname === '/dsh-tingbar/cloud/favs' && req.method === 'GET') {
        if (!provider.supports.cloudFavs || typeof provider.collections !== 'function') {
          unsupported(res, platform, '云端收藏')
          return
        }
        try {
          const result = await provider.collections(cookieOf(platform))
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 收藏专辑（增/删，按平台分开存）。
      if (pathname === '/dsh-tingbar/fav' && req.method === 'POST') {
        const body = await readBody(req)
        const album = body && body.album
        if (!album || typeof album.id !== 'number') { writeJson(res, { ok: false, error: '无效的专辑' }, 400); return }
        const list = state.favs[platform]
        if (body.remove === true) {
          state.favs[platform] = list.filter((f) => f.id !== album.id)
        } else {
          state.favs[platform] = [
            {
              id: album.id, title: album.title || '', cover: album.cover || '',
              anchorName: album.anchorName || '', trackCount: album.trackCount || 0,
              category: album.category || '', isPaid: !!album.isPaid,
              platform, addedAt: Date.now(),
            },
            ...list.filter((f) => f.id !== album.id),
          ].slice(0, 200)
        }
        await saveState()
        writeJson(res, { ok: true, platform, favs: state.favs[platform] })
        return
      }

      // 已关注的主播列表（喜马拉雅专有）。
      if (pathname === '/dsh-tingbar/following' && req.method === 'GET') {
        if (!provider.supports.following) { unsupported(res, platform, '关注列表'); return }
        let uid = Number(url.searchParams.get('uid') || 0)
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20))
        if (!Number.isInteger(uid) || uid <= 0) {
          // 未显式给 uid：用当前登录用户（cookie 在但 user 未就绪时先刷新一次）。
          let user = userOf(platform)
          if ((!user || !user.uid) && cookieOf(platform) !== '') user = await refreshUser(platform)
          uid = (user && user.uid) || 0
        }
        if (uid <= 0) {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看已关注的主播' }, 401)
          return
        }
        try {
          const result = await provider.following(uid, page, pageSize, cookieOf(platform))
          writeJson(res, { ok: true, platform, uid, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 收藏（喜欢）的声音列表（需登录，喜马拉雅专有）。
      if (pathname === '/dsh-tingbar/likes' && req.method === 'GET') {
        if (!provider.supports.likes) { unsupported(res, platform, '收藏的声音'); return }
        if (cookieOf(platform) === '') {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看收藏的声音' }, 401)
          return
        }
        const pageNum = Math.max(1, parseInt(url.searchParams.get('pageNum') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        try {
          const result = await provider.likes(pageNum, pageSize, cookieOf(platform))
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 我的订阅：订阅的专辑列表（需登录，喜马拉雅专有）。
      if (pathname === '/dsh-tingbar/subscriptions' && req.method === 'GET') {
        if (!provider.supports.subscriptions) { unsupported(res, platform, '订阅列表'); return }
        if (cookieOf(platform) === '') {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看订阅的专辑' }, 401)
          return
        }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        try {
          const result = await provider.subscriptions(page, pageSize, cookieOf(platform))
          writeJson(res, { ok: true, platform, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 主播主页：公开专辑列表（匿名可用，喜马拉雅专有）。
      if (pathname === '/dsh-tingbar/anchor' && req.method === 'GET') {
        if (!provider.supports.anchor) { unsupported(res, platform, '主播主页'); return }
        const uid = Number(url.searchParams.get('uid') || 0)
        if (!Number.isInteger(uid) || uid <= 0) { writeJson(res, { ok: false, error: '无效的主播 ID' }, 400); return }
        try {
          const result = await provider.anchor(uid)
          writeJson(res, { ok: true, platform, uid, ...result })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 云端写操作（需登录，喜马拉雅专有）：订阅/退订专辑、取消收藏声音、取消关注主播。
      // 设置方向的点赞/关注经实测会被风控拦截（需浏览器指纹），只开放纯接口可靠的方向。
      if (pathname === '/dsh-tingbar/write' && req.method === 'POST') {
        if (!provider.supports.write) { unsupported(res, platform, '云端收藏/订阅同步'); return }
        const body = await readBody(req)
        const op = body.op
        const on = body.on !== false // 缺省 true
        const id = Number(body.id)
        if (!Number.isInteger(id) || id <= 0) { writeJson(res, { ok: false, error: '无效的 ID' }, 400); return }
        if (!['sub', 'like', 'follow'].includes(op)) {
          writeJson(res, { ok: false, error: '不支持的 op（可用：sub / like / follow）' }, 400); return
        }
        if (cookieOf(platform) === '') {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能同步到云端' }, 401)
          return
        }
        try {
          const result = await provider.write(op, id, on, cookieOf(platform))
          writeJson(res, { ok: true, platform, op, id, on, msg: result.msg })
        } catch (err) { fail(res, platform, err) }
        return
      }

      // 播放意图（工具触发，轮询即取即焚）。
      if (pathname === '/dsh-tingbar/intent' && req.method === 'GET') {
        // 有待执行的诊断指令时优先下发（一次性），否则给正常的播放意图。
        if (diagCmd !== null) {
          const cmd = diagCmd
          diagCmd = null
          writeJson(res, { ok: true, intent: { action: 'diag', cmd } })
          return
        }
        writeJson(res, { ok: true, intent: takeIntent() })
        return
      }

      // Web 端回报现场数据（播放/跳转的真实数值）。
      if (pathname === '/dsh-tingbar/diag' && req.method === 'POST') {
        const body = await readBody(req) // readBody 已解析为对象
        const payload = (body && typeof body === 'object') ? body : { raw: String(body) }
        diagLog.push({ at: Date.now(), ...payload })
        if (diagLog.length > 40) diagLog.shift()
        writeJson(res, { ok: true })
        return
      }
      if (pathname === '/dsh-tingbar/diag' && req.method === 'GET') {
        writeJson(res, { ok: true, items: diagLog, streams: streamLog })
        return
      }
      // 下发一次性诊断指令：{op:'seek', delta:15} / {op:'step', dir:1} / {op:'snapshot'}。
      if (pathname === '/dsh-tingbar/diag/cmd' && req.method === 'POST') {
        const cmd = await readBody(req) // readBody 已解析为对象
        if (cmd === null || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
          writeJson(res, { ok: false, error: '需要 {op:"seek"|"step"|"snapshot", ...}' }, 400)
          return
        }
        diagCmd = cmd
        writeJson(res, { ok: true, cmd })
        return
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      } catch { /* socket gone */ }
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tingbar', handler: serve }), 'ximalaya: routes')
  // 插件卸载/热重载时关掉回环音频口，避免端口泄漏。
  ctx.effect(() => () => { closeAudioServer() }, 'ximalaya: audio server')

  // ---- model tool: ximalaya_play ----
  const ACTIONS = ['play', 'pause', 'resume', 'stop', 'next', 'prev']
  const tool = {
    name: 'ximalaya_play',
    description: '收听有声书/播客/相声，支持喜马拉雅与懒人听书两个平台。action=play（默认）时按关键词搜索并播放：query 传专辑或声音关键词（如「三体」「郭德纲相声」），也可直接传 albumId 或 trackId；platform 选平台（ximalaya 喜马拉雅 / lrts 懒人听书，缺省按面板当前选择）。其余 action 控制播放：pause 暂停、resume 继续、stop 停止、next 下一集、prev 上一集。播放与控制在浏览器播放条上进行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '专辑/声音关键词（如「三体」「郭德纲相声」）。仅 action=play 时使用' },
        platform: { type: 'string', enum: PLATFORM_IDS, description: '平台：ximalaya=喜马拉雅，lrts=懒人听书；缺省用面板当前选中的平台' },
        albumId: { type: 'number', description: '直接指定专辑/书籍 ID。仅 action=play 时使用，优先级高于 query' },
        trackId: { type: 'number', description: '直接指定曲目/章节 ID。仅 action=play 时使用，优先级最高' },
        action: { type: 'string', enum: ACTIONS, description: 'play 播放（默认）、pause 暂停、resume 继续、stop 停止、next 下一集、prev 上一集' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string' }, platform: { type: 'string' }, played: { type: 'boolean' },
          album: { type: 'string' }, track: { type: 'string' },
          matches: { type: 'number' }, notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || (value && value.track ? '已请求播放：' + value.track : '操作已提交') }]
      },
    },
    async execute(args) {
      await ensureState()
      const action = args && typeof args.action === 'string' && ACTIONS.includes(args.action) ? args.action : 'play'
      const target = args && isPlatform(args.platform) ? args.platform : currentPlatform()
      const provider = providerOf(target)
      const label = labelOf(target)
      const cookie = cookieOf(target)

      // 非播放动作：直接投递给浏览器播放条。
      if (action !== 'play') {
        pendingIntent = { action, platform: target }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          next: '已请求播放下一集', prev: '已请求播放上一集',
        }
        return { action, platform: target, played: false, album: '', track: '', matches: 0, notice: labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。' }
      }

      // 直接指定曲目。
      const trackId = args && Number.isFinite(args.trackId) ? Number(args.trackId) : 0
      if (trackId > 0) {
        const albumId = args && Number.isFinite(args.albumId) ? Number(args.albumId) : 0
        pendingIntent = { action: 'play', platform: target, trackId, albumId }
        return { action, platform: target, played: true, album: '', track: '曲目 #' + trackId, matches: 1, notice: '已请求播放' + label + '曲目 #' + trackId + '。浏览器可能拦截自动播放，请在播放条点击一次▶解锁。' }
      }

      // 直接指定专辑：取第一页曲目，从第一集播起。
      const albumId = args && Number.isFinite(args.albumId) ? Number(args.albumId) : 0
      if (albumId > 0) {
        try {
          const album = await provider.album(albumId, cookie)
          const list = await provider.tracks({ albumId, pageId: 1, pageSize: 30, cookie })
          if (list.tracks.length === 0) {
            return { action, platform: target, played: false, album: album.title, track: '', matches: 0, notice: label + '「' + album.title + '」没有可播放的曲目。' }
          }
          const first = list.tracks[0]
          pendingIntent = { action: 'play', platform: target, albumId, albumTitle: album.title, trackId: first.id, trackTitle: first.title, section: first.section }
          return { action, platform: target, played: true, album: album.title, track: first.title, matches: list.tracks.length, notice: '已请求播放' + label + '「' + album.title + '」第 1 集（共 ' + list.totalCount + ' 集）。若被拦截请点 ▶ 解锁。' }
        } catch (err) {
          const info = provider.errorInfo(err)
          return { action, platform: target, played: false, album: '', track: '', matches: 0, notice: label + '专辑获取失败：' + info.message + (info.needLogin ? '（需先在面板扫码登录）' : '') }
        }
      }

      // 关键词搜索。
      const query = args && typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') {
        return { action, platform: target, played: false, album: '', track: '', matches: 0, notice: '请提供 query 关键词（专辑/声音名），或直接传 albumId/trackId。' }
      }
      try {
        const { albums } = await provider.search(query, 1, 10, cookie)
        if (albums.length === 0) {
          return { action, platform: target, played: false, album: '', track: '', matches: 0, notice: label + '没有找到「' + query + '」相关的专辑。' }
        }
        // 优先标题完全包含关键词的结果，否则取第一个。
        const lower = query.toLowerCase()
        const pick = albums.find((a) => String(a.title).toLowerCase().includes(lower)) || albums[0]
        const list = await provider.tracks({ albumId: pick.id, pageId: 1, pageSize: 30, cookie })
        if (list.tracks.length === 0) {
          return { action, platform: target, played: false, album: pick.title, track: '', matches: 0, notice: label + '「' + pick.title + '」没有可播放的曲目。' }
        }
        const first = list.tracks[0]
        pendingIntent = { action: 'play', platform: target, albumId: pick.id, albumTitle: pick.title, trackId: first.id, trackTitle: first.title, section: first.section }
        return {
          action, platform: target, played: true, album: pick.title, track: first.title, matches: albums.length,
          notice: '已请求播放' + label + '「' + pick.title + '」（' + (pick.anchorName || '') + '，共 ' + list.totalCount + ' 集）第 1 集：' + first.title + '。若被拦截请点 ▶ 解锁。免费内容可直接播；VIP/已购内容需先在面板扫码登录。',
        }
      } catch (err) {
        const info = provider.errorInfo(err)
        return { action, platform: target, played: false, album: '', track: '', matches: 0, notice: label + '搜索失败：' + info.message + (info.needLogin ? '（需先在面板扫码登录）' : '') }
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'ximalaya: ximalaya_play tool')

  // ---- system prompt 提示 ----
  ctx.systemPrompt.section({
    name: 'tool:ximalaya', order: 117,
    text: '本机已挂载听说播放器，支持两个平台：喜马拉雅（platform=ximalaya）与懒人听书（platform=lrts）。用 ximalaya_play 工具按关键词（专辑名/声音名，如「三体」「郭德纲相声」）搜索并播放在线内容，也可传 albumId/trackId 精确播放；不传 platform 时用播放面板当前选中的平台。并支持 action 暂停/继续/停止/下一集/上一集。喜马拉雅免费专辑匿名即可播，VIP/付费内容需用户已在面板扫码登录；懒人听书的搜索与收听都要求先在面板扫码登录。',
  })

  void loadState()
}
