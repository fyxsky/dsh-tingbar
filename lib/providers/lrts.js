/**
 * lib/providers/lrts.js — 懒人听书 / 懒人畅听 provider。
 *
 * 协议来源：官方 Web SPA（https://www.lanrentingshu.com，与 www.lrts.me 同一套前端）。
 * 全部接口同源 + Cookie 鉴权（前端每次请求都带 credentials:'include'，没有 Authorization 头）。
 *
 * 关键事实（实测 + 前端源码核对）：
 *   - 扫码登录：POST /api/user/webQrCreate → {data:{sceneToken, expireAt}}；
 *     轮询 POST /api/user/webQrStatus {sceneToken} → {data:{status:'waiting'|'expired'|'success'}}；
 *     二维码内容 = `https://m.lrts.me/activity/webQrLogin/index?sceneToken=<token>`，
 *     官方前端用 qrcode 库把它画成 180px 画布 —— 服务端不返图，必须自己生成。
 *   - 搜索 /api/search/searchBookAlbum 需登录（status 485 LOGIN_REQUIRED）。
 *   - 书目 /api/book/detail?id= 匿名可用；章节目录 /api/book/resource?bookId=&pageNo=&pageSize=
 *     匿名可拿列表，但 path 恒为空 —— 收听地址必须走
 *     GET /api/gateway/getListenPath?entityType=1&entityId=<bookId>&section=<section>&opType=0&quality=1
 *     取返回体的 data.path（前端源码里 `T = w.path || w.listenPath` 后直接 `audio.src = T`）。
 *   - 返回信封 {status, msg, data}：SUCCESS=0 / 'success'，LOGIN_REQUIRED=485，NOLOGIN=9999。
 */

import QRCode from 'qrcode'

export const BASE = 'https://www.lanrentingshu.com'
const QR_LOGIN_ENTRY = 'https://m.lrts.me/activity/webQrLogin/index'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const MIME = 'audio/mp4' // 懒人回源多为 m4a/mp3，content-type 以响应头为准

// 信封状态码（前端常量表 CO3S2Chi.js）
const ST = { SUCCESS: 0, WEB_SUCCESS: 'success', LOGIN_REQUIRED: 485, NOLOGIN: 9999 }

// 排行榜：网页端 /discover/ranking 侧栏由 groupList 提供（5 个分组：全部/出版/儿童/节目/主播，
// 每组下若干张榜）。主播组是「主播榜」（rankType 6，内容为播主而非书/专辑，走 announcerList 接口），
// 与「听书榜单」不同，插件只保留书籍/专辑榜（rankType 0）。
// 下面是「全部」组的 9 张榜，用作 groupList 拉不到时的兜底：
const RANK_FALLBACK = [
  { rankingId: 75, name: '热播榜' },
  { rankingId: 265, name: '畅销榜' },
  { rankingId: 738, name: '新书榜' },
  { rankingId: 77, name: '热搜榜' },
  { rankingId: 76, name: '好评榜' },
  { rankingId: 14479, name: '收藏榜' },
  { rankingId: 739, name: '完结榜' },
  { rankingId: 14481, name: '免费榜' },
  { rankingId: 740, name: '会员榜' },
]

export class LrtsError extends Error {
  constructor(message, code = 'ERROR', status = 500) {
    super(message)
    this.name = 'LrtsError'
    this.code = code
    this.status = status
  }
}

// ---- cookie ----
export function joinCookieMap(cookies) {
  if (!cookies || typeof cookies !== 'object') return ''
  return Object.entries(cookies)
    .filter(([k, v]) => typeof k === 'string' && k !== '' && typeof v === 'string')
    .map(([k, v]) => k + '=' + v)
    .join('; ')
}

/** 把 Set-Cookie 头解析成 {name: value}（只取 name=value，忽略属性）。 */
export function parseSetCookie(list) {
  const out = {}
  for (const raw of list || []) {
    if (typeof raw !== 'string' || raw === '') continue
    const pair = raw.split(';', 1)[0]
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name !== '') out[name] = value
  }
  return out
}

function setCookieList(res) {
  try {
    if (res.headers && typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie()
  } catch { /* fall through */ }
  const single = res.headers && res.headers.get('set-cookie')
  return single ? [single] : []
}

// ---- 底层请求 ----
async function request(path, { method = 'GET', query, body, cookie } = {}) {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }
  url.searchParams.set('_t', String(Date.now()))
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    referer: BASE + '/',
    origin: BASE,
  }
  if (method === 'POST') headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie

  let res
  try {
    res = await fetch(url, { method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined, redirect: 'follow' })
  } catch (err) {
    throw new LrtsError('网络异常：' + String((err && err.message) || err), 'NETWORK', 502)
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  const cookies = parseSetCookie(setCookieList(res))
  if (json === null) {
    throw new LrtsError('懒人听书返回非 JSON（HTTP ' + res.status + '）', 'BAD_RESPONSE', 502)
  }
  const status = json.status !== undefined ? json.status : json.apiStatus
  const ok = status === ST.SUCCESS || status === ST.WEB_SUCCESS || status === undefined || status === null
  if (!ok) {
    const n = Number(status)
    if (n === ST.LOGIN_REQUIRED) throw new LrtsError('需要登录懒人听书账号', 'NEED_AUTH', 401)
    if (n === ST.NOLOGIN) throw new LrtsError('需要登录懒人听书账号', 'NOLOGIN', 401)
    throw new LrtsError(String(json.msg || '懒人听书接口错误：' + status), 'API_RET', 502)
  }
  return { body: json, data: json.data !== undefined ? json.data : json, cookies, status: res.status }
}

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const pick = (...values) => {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v
  return ''
}

// ---- 归一化 ----
function toAlbum(raw, fallbackId = 0) {
  const id = num(pick(raw && raw.id, raw && raw.entityId, raw && raw.albumId, raw && raw.bookId, fallbackId))
  const listenPrice = num(pick(raw && raw.listenPrice, raw && raw.price))
  const feeType = num(pick(raw && raw.feeType, raw && raw.payType))
  return {
    id,
    title: String(pick(raw && raw.name, raw && raw.realName, raw && raw.title)),
    intro: String(pick(raw && raw.desc, raw && raw.intro, raw && raw.description)),
    cover: String(pick(raw && raw.cover, raw && raw.bestCover, raw && raw.pic)),
    trackCount: num(pick(raw && raw.sections, raw && raw.sectionCount, raw && raw.bookCount, raw && raw.resourceCount)),
    anchorName: String(pick(raw && raw.announcer, raw && raw.author, raw && raw.nickName)),
    category: String(pick(raw && raw.type, raw && raw.typeName, raw && raw.categoryName)),
    isPaid: listenPrice > 0 || feeType === 1,
    isFinished: num(pick(raw && raw.state)) === 2,
    playCount: num(pick(raw && raw.play, raw && raw.playCount, raw && raw.plays)),
    platform: 'lrts',
  }
}

function toTrack(raw, albumId) {
  const section = num(pick(raw && raw.section, raw && raw.sortNum))
  const sectionId = pick(raw && raw.sectionId, raw && raw.id)
  const listenPrice = num(pick(raw && raw.listenPrice, raw && raw.price))
  const feeType = num(pick(raw && raw.feeType, raw && raw.payType))
  const vipEnd = num(pick(raw && raw.vipPriorityEndTime))
  const isPaid = listenPrice > 0 || feeType === 1
  return {
    id: num(sectionId),
    title: String(pick(raw && raw.name, raw && raw.title)),
    duration: num(pick(raw && raw.length, raw && raw.duration)),
    orderNo: section,
    section,
    albumId: num(albumId),
    isPaid,
    isFree: !isPaid,
    isVip: feeType === 2 || (vipEnd > 0 && vipEnd > Date.now()),
    isAuthorized: num(pick(raw && raw.cantListen)) === 0,
    playCount: num(pick(raw && raw.plays, raw && raw.play)),
    // 腾讯音乐资源号：getListenPath 唯一认的播放凭据（不是 sectionId）。
    tmeId: String(pick(raw && raw.tmeId)),
    cover: String(pick(raw && raw.cover)),
    albumTitle: '',
    anchorName: '',
    intro: String(pick(raw && raw.desc)),
    platform: 'lrts',
  }
}

/** 时间戳下限：小于 2001 年的数字一律当「不是时间戳」，避免把天数当毫秒。 */
const MIN_TS_MS = 1e12

/**
 * 用户信息归一化。
 *
 * 会员判定有个坑：懒人听书的 /api/user/getUserInfo **没有 isVip 字段**，权威值是
 *   - vipExpireTime / vipBuyExpireTime（毫秒时间戳，会员到期时间）
 *   - timeRemaining（剩余天数，实测与 vipExpireTime 差一天以内对得上）
 *   - vipType（0=普通会员，>0=更高档位）、feeType（3=会员账号）
 * 之前按 isVip/vipLevel 找，两个字段都不存在，所以永远显示「普通账号」。
 */
function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') return null
  const uid = num(pick(raw.userId, raw.uid, raw.id))
  const nickname = String(pick(raw.nickName, raw.nickname, raw.name, raw.userName))
  if (uid <= 0 && nickname === '') return null
  const rawExpire = num(pick(raw.vipExpireTime, raw.vipBuyExpireTime, raw.vipExpireTimeNonExperience))
  const vipUntil = rawExpire >= MIN_TS_MS ? rawExpire : 0
  const daysFromExpire = vipUntil > 0 ? Math.ceil((vipUntil - Date.now()) / 86400000) : 0
  const rawRemain = num(pick(raw.timeRemaining))
  const daysFromRemain = rawRemain > 0 && rawRemain < 4000 ? rawRemain : 0
  const vipDays = Math.max(0, daysFromExpire, daysFromRemain)
  const vipLevel = num(pick(raw.vipType, raw.vipLevel))
  const isVip = vipDays > 0 || num(pick(raw.isVip, raw.vipStatus)) > 0
  return {
    uid,
    nickname,
    avatar: String(pick(raw.avatar, raw.avatarUrl, raw.headImg, raw.portrait, raw.icon, raw.cover, raw.originCover)),
    isVip,
    vipLevel: isVip ? vipLevel : 0,
    vipDays: isVip ? vipDays : 0,
    vipUntil: isVip ? vipUntil : 0,
    platform: 'lrts',
    raw,
  }
}

/** 章节目录：兼容 list 在信封根节点或 data.list 两种形态。 */
function trackList(body) {
  const data = body && body.data
  const list = (data && Array.isArray(data.list) && data.list)
    || (Array.isArray(body && body.list) && body.list)
    || (data && Array.isArray(data.sections) && data.sections)
    || []
  const sections = num(pick(data && data.sections, body && body.sections, list.length))
  return { list, sections }
}

/**
 * 章节目录缓存 + 本地切片分页。
 *
 * 实测（2026-11-15）：`/api/book/resource` **完全忽略 pageNo**，永远返回前 N 条；
 * 单次最多返回 1000 条（pageSize=9999 也只给 1000）。所以「服务端分页」这条路走不通，
 * 只能一次取满（上限 1000 章）再在本地切片——好处是「加载更多」瞬间完成、不再重复第 1 页。
 * 超过 1000 章的书，尾部章节匿名状态下拿不到（`truncated` 标记，UI 会提示）。
 */
const SECTION_CACHE = new Map()
const SECTION_TTL = 10 * 60 * 1000
const SECTION_CAP = 1000

export function clearSectionCache() {
  SECTION_CACHE.clear()
}

async function allSections(albumId, cookie, force = false) {
  const key = String(albumId)
  const hit = SECTION_CACHE.get(key)
  if (!force && hit && Date.now() - hit.at < SECTION_TTL) return hit
  const { body } = await request('/api/book/resource', {
    query: { bookId: albumId, pageNo: 1, pageSize: SECTION_CAP }, cookie,
  })
  const { list, sections } = trackList(body)
  const entry = { at: Date.now(), list, sections: sections > 0 ? sections : list.length }
  SECTION_CACHE.set(key, entry)
  return entry
}

export const lrtsProvider = {
  id: 'lrts',
  label: '懒人听书',
  // 官方 Web 端连免费章节都强制登录，所以搜索/播放/「我的」都需要登录；书目详情匿名可看。
  needsLogin: { search: true, browse: false, play: true, mine: true },
  supports: {
    following: false, likes: false, subscriptions: false, anchor: false, write: false, home: true,
    cloudFavs: true, cloudHistory: true,
    // 网页端没有热搜接口（searchSuggest 返回 SPA 空壳）；榜单有 3 张可用（见 RANK_BOARDS）。
    hotWords: false, ranks: true,
  },
  qrHint: '打开懒人听书 App → 右上角扫一扫',
  platformHint: '书籍页 URL 里 /book/<数字> 的编号',
  mime: MIME,

  joinCookies: joinCookieMap,

  // ---- 扫码登录 ----
  async qrCreate() {
    const { body } = await request('/api/user/webQrCreate', { method: 'POST', body: {} })
    const sceneToken = body && body.data && body.data.sceneToken
    if (!sceneToken) throw new LrtsError('创建二维码失败：未返回 sceneToken', 'BAD_RESPONSE', 502)
    const expireAt = num(body.data.expireAt)
    const expiresAt = expireAt > 0
      ? (expireAt > 1e10 ? expireAt : expireAt * 1000)
      : Date.now() + 5 * 60 * 1000
    const payload = QR_LOGIN_ENTRY + '?sceneToken=' + encodeURIComponent(sceneToken)
    const imageDataUrl = await QRCode.toDataURL(payload, {
      width: 240, margin: 1, color: { dark: '#1A1A1A', light: '#FFFFFF' },
    })
    return { sceneToken, payload, imageDataUrl, expiresAt, hint: this.qrHint }
  },

  async qrCheck(session) {
    if (!session || !session.sceneToken) return { status: 'expired' }
    const { body, cookies } = await request('/api/user/webQrStatus', {
      method: 'POST', body: { sceneToken: session.sceneToken },
    })
    const status = String(pick(body && body.data && body.data.status))
    if (status === 'success') {
      return { status: 'success', cookies, user: (body.data && body.data.user) || null }
    }
    if (status === 'expired' || (session.expiresAt && session.expiresAt < Date.now())) {
      return { status: 'expired' }
    }
    if (status === 'waiting') return { status: 'waiting' }
    if (Object.keys(cookies).length > 0) return { status: 'success', cookies }
    return { status: 'waiting' }
  },

  async logout() {
    try { await request('/api/user/logout', { method: 'POST', body: {} }) } catch { /* 忽略 */ }
  },

  // ---- 用户 ----
  async user(cookie) {
    if (!cookie) return null
    try {
      const { body } = await request('/api/user/getUserInfo', { cookie })
      return normalizeUser(body && body.data !== undefined ? body.data : body)
    } catch (err) {
      if (err instanceof LrtsError && (err.code === 'NOLOGIN' || err.code === 'NEED_AUTH')) return null
      throw err
    }
  },

  // ---- 搜索（需登录）----
  async search(kw, page = 1, size = 20, cookie) {
    if (!cookie) throw new LrtsError('搜索懒人听书需要先扫码登录', 'NEED_AUTH', 401)
    const { body } = await request('/api/search/searchBookAlbum', {
      query: { keyword: kw, pageNo: page, pageSize: size }, cookie,
    })
    const data = (body && body.data) || {}
    const list = data.bookAlbums || data.list || data.albums || body.bookAlbums || []
    const albums = (Array.isArray(list) ? list : []).map((x) => toAlbum(x))
    return {
      albums,
      total: num(pick(data.total, body.total, albums.length)),
      page,
      totalPages: num(pick(data.totalPage, data.pages, 1), 1),
    }
  },

  // ---- 书目详情（匿名可用）----
  async album(id, cookie) {
    const { body } = await request('/api/book/detail', { query: { id }, cookie })
    const detail = (body && body.data && body.data.detail) || (body && body.data) || {}
    if (!detail || Object.keys(detail).length === 0) throw new LrtsError('书籍不存在或已下架', 'NOT_FOUND', 404)
    const album = toAlbum(detail, id)
    const users = Array.isArray(detail.users) ? detail.users : []
    if (album.anchorName === '' && users.length > 0) album.anchorName = String(pick(users[0].nickName, users[0].name))
    return album
  },

  // ---- 章节目录（匿名可用，path 需登录）----
  // 服务端不分页（见 allSections 注释），这里一次取满再本地切片。
  async tracks({ albumId, pageId = 1, pageSize = 30, cookie, force = false }) {
    const { list, sections } = await allSections(albumId, cookie, force === true)
    const size = Math.max(1, pageSize)
    const page = Math.max(1, pageId)
    const total = sections > 0 ? sections : list.length
    const start = (page - 1) * size
    // 末页按 totalCount 截断（与喜马拉雅口径一致：服务端说有多少集就只到多少集），
    // 同时不超过实际拿到的条数（truncated 时 list 可能比 total 短）。
    const end = Math.min(start + size, total, list.length)
    return {
      tracks: list.slice(start, end).map((x) => toTrack(x, albumId)),
      totalCount: total,
      pageId: page,
      maxPageId: Math.max(1, Math.ceil(Math.min(total, list.length) / size)),
      // 目录超过单次上限（1000 章）时尾部拿不到，UI 用来提示。
      truncated: total > list.length,
    }
  },

  // ---- 上一集 / 下一集：在整份目录里定位相邻章节 ----
  // 不能只靠客户端已加载的目录分页：从「历史」或搜索结果直接起播时，那一页目录
  // 根本没加载过（懒人听书的书动辄 800+ 集，从第 800 集起播就必然落空）。
  // 这里直接查 SECTION_CACHE / 一次取满的目录，按 section 定位再取 ±1。
  async neighbor({ albumId, trackId, section, dir = 1, cookie }) {
    const bookId = num(albumId)
    if (!(bookId > 0)) throw new LrtsError('缺少专辑 id', 'BAD_ARGS', 400)
    const step = num(dir) >= 0 ? 1 : -1
    const { list } = await allSections(bookId, cookie)
    const sec = num(pick(section))
    const id = num(pick(trackId))
    let idx = -1
    // 章节序号是最稳的定位键；id（sectionId）作为兜底。
    if (sec > 0) idx = list.findIndex((x) => num(pick(x.section, x.sortNum)) === sec)
    if (idx < 0 && id > 0) idx = list.findIndex((x) => num(pick(x.sectionId, x.id)) === id)
    if (idx < 0) return { track: null, index: -1, total: list.length }
    const next = idx + step
    return {
      track: next >= 0 && next < list.length ? toTrack(list[next], bookId) : null,
      index: next,
      total: list.length,
    }
  },

  // ---- 云端收藏（需登录）----
  // 前端源码：`ee=e=>d.post('/api/collection/getCollectionBooks', e)`，调用处传 {ids:'0'}
  // 表示「一次取回全部收藏」；列表项 updateState===2 表示已取消收藏，前端会过滤掉。
  async collections(cookie) {
    if (!cookie) throw new LrtsError('查看收藏需要先扫码登录', 'NEED_AUTH', 401)
    const { body } = await request('/api/collection/getCollectionBooks', {
      method: 'POST', body: { ids: '0' }, cookie,
    })
    const data = (body && body.data) || body || {}
    const list = Array.isArray(data.list) ? data.list : []
    const albums = list
      .filter((x) => x && num(pick(x.updateState)) !== 2)
      .map((x) => toAlbum(x))
      .filter((x) => x.id > 0)
    return { albums, total: albums.length, referId: String(pick(data.referId)) }
  },

  // ---- 云端收听记录（需登录；即网页端 /user/history 那份）----
  // 前端源码：`y=(e,t)=>d.get('/api/collection/getRecentListenBooks',e,t)`，
  // 列表在信封根节点 `list`，翻页靠 `referId` 游标（pageNo 无效）。
  async listened(cookie, { pageSize = 30, referId = '' } = {}) {
    if (!cookie) throw new LrtsError('查看收听记录需要先扫码登录', 'NEED_AUTH', 401)
    const { body } = await request('/api/collection/getRecentListenBooks', {
      query: { srcType: 101, ...(referId === '' ? {} : { referId }) },
      cookie,
    })
    const list = Array.isArray(body && body.list) ? body.list : []
    const items = list
      .filter((x) => x && num(pick(x.isDelete)) !== 1)
      .map((x) => ({
        trackId: num(pick(x.sonId, x.resourceId)),
        trackTitle: String(pick(x.resourceName, x.shortName, x.name)),
        albumId: num(pick(x.bookId, x.id)),
        albumTitle: String(pick(x.name)),
        anchorName: String(pick(x.announcer)),
        cover: String(pick(x.cover)),
        // listpos = 章节序号（播放要用），playpos = 秒级进度，duration = 章节总秒数。
        section: num(pick(x.listpos)),
        position: num(pick(x.playpos)),
        duration: num(pick(x.duration)),
        updatedAt: num(pick(x.lastListenTime)),
        updatedText: String(pick(x.date)),
      }))
      .filter((x) => x.trackId > 0 || x.albumId > 0)
    // 上游按 referId 游标翻页：这一页满 pageSize 条就当还有下一页（多探测一次，
    // 拿到 0 条时客户端自然熄灭「加载更多」），不满则肯定到头了。
    const capped = Math.max(1, Math.min(Number(pageSize) || 30, 100))
    return {
      items: items.slice(0, capped),
      all: items.length,
      totalCount: items.length,
      referId: String(pick(body && body.referId)),
      hasMore: items.length >= capped,
    }
  },

  // ---- 收听地址（需登录）----
  // getListenPath 的 trackId/resId 必须是章节的 tmeId（腾讯音乐资源号），
  // 传 sectionId 会得到 status:20 + 空 path（会被误读成「需要会员」）。
  async resolvePlay({ trackId, tmeId, albumId, section, cookie }) {
    if (!cookie) throw new LrtsError('收听懒人听书需要先扫码登录', 'NEED_AUTH', 401)
    const bookId = num(albumId)
    const sec = section === undefined || section === null || section === '' ? null : num(section)

    let token = String(pick(tmeId, ''))
    // 调用方没带 tmeId（例如从云端收听记录续播）时，用目录缓存按 section 反查一次。
    if (token === '' && bookId > 0 && sec !== null) {
      const cached = await allSections(bookId, cookie)
      const hit = cached.list.find((x) => num(pick(x && x.section)) === sec)
      token = String(pick(hit && hit.tmeId, ''))
    }
    if (token === '') {
      throw new LrtsError('缺少播放资源号（tmeId），无法解析收听地址', 'BAD_ARGS', 400)
    }
    if (bookId <= 0) {
      throw new LrtsError('缺少书籍信息，无法解析收听地址', 'BAD_ARGS', 400)
    }

    const { body } = await request('/api/gateway/getListenPath', {
      query: {
        entityType: 1,
        entityId: bookId,
        trackId: token,
        section: sec === null ? 0 : sec,
        resId: token,
        opType: 0,
        quality: 1,
      },
      cookie,
    })
    const data = (body && body.data) || body || {}
    const url = String(pick(data.path, data.listenPath, data.url))
    if (url === '') {
      const code = num(pick(body && body.status, body && body.apiStatus))
      // status:20 = 资源号无效/章节不存在；别的码再往会员权限上想。
      if (code === 20) {
        throw new LrtsError('该章节的播放资源号无效（可能已下架或需要客户端重新拉取目录）', 'API_RET', 502)
      }
      throw new LrtsError('这本书需要会员或购买后才能收听（账号无权限）', 'NEED_VIP', 403)
    }
    return {
      url,
      quality: '标准音质',
      source: 'getListenPath',
      title: '',
      duration: num(pick(data.duration, data.length)),
      pathMeta: String(pick(data.pathMeta)),
    }
  },

  streamHeaders() {
    return { 'user-agent': UA, referer: BASE + '/' }
  },

  // ---- 首页推荐（匿名可用，登录前可逛）----
  async home(cookie) {
    const { body } = await request('/api/home/webHomePage', { cookie })
    const data = (body && body.data) || {}
    const list = Array.isArray(data.recommendEntityList) ? data.recommendEntityList : []
    const albums = list
      .map((x) => x && (x.bookAlbum || x.album || x.book || x.entity))
      .filter((x) => x && (x.id !== undefined || x.entityId !== undefined))
      .map((x) => toAlbum(x))
    return { albums, total: albums.length }
  },

  // ---- 分类榜单（网页端 /discover/ranking，匿名可用）----
  async rankCats() {
    // 懒人的「分类」就是榜单本身：侧栏由 groupList 提供（分组 → 榜单两级）。
    // 只保留书籍/专辑榜（rankType 0），主播榜（rankType 6）是播主榜、走不同接口，不在听书榜单范围内。
    try {
      const { data } = await request('/api/ranking/groupList', { query: { groupId: 0, groupType: 1 } })
      const groups = Array.isArray(data && data.list) ? data.list : []
      const tabs = groups
        .map((g, gi) => {
          const name = String(pick((g && g.rankingsGroupInfoView && g.rankingsGroupInfoView.name), g && g.name) || '').trim()
          const wraps = (Array.isArray(g && g.rankingsList) ? g.rankingsList : [])
            .filter((b) => num(pick(b && b.rankType)) === 0 && num(pick(b && b.rankId)) > 0)
            .map((b) => ({
              id: num(pick(b && b.rankId)),
              name: String(pick(b && b.rankName) || '').trim(),
              rankingId: num(pick(b && b.rankId)),
            }))
            .filter((b) => b.name !== '')
          return { id: gi + 1, name, wraps }
        })
        .filter((t) => t.name !== '' && t.wraps.length > 0)
      if (tabs.length > 0) return { tabs, updatedAt: Date.now() }
    } catch { /* 落到兜底 */ }
    return { tabs: [{ id: 0, name: '排行榜', wraps: RANK_FALLBACK.map((b) => ({ id: b.rankingId, name: b.name, rankingId: b.rankingId })) }], updatedAt: Date.now() }
  },

  async rankContent(rankingId) {
    const id = Number(rankingId)
    if (!Number.isInteger(id) || id <= 0) throw new LrtsError('榜单参数缺失', 'BAD_ARGS', 400)
    const { data } = await request('/api/ranking/resList', { query: { rankId: id, rangeType: 3, pageSize: 100 } })
    const list = Array.isArray(data && data.list) ? data.list : []
    const albums = list.map((x) => {
      const a = toAlbum(x)
      a.playCount = num(pick(x && x.hot))
      return a
    })
    return {
      rankingId: id,
      title: String(pick(data && data.rankName, data && data.name) || ''),
      subtitle: '',
      count: albums.length,
      albums,
    }
  },

  errorInfo(err) {
    const code = err instanceof LrtsError ? err.code : ''
    return {
      status: err instanceof LrtsError ? err.status : 500,
      message: String((err && err.message) || err),
      needLogin: code === 'NEED_AUTH' || code === 'NOLOGIN',
      needVip: code === 'NEED_VIP',
    }
  },
}
