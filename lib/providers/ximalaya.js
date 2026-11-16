/**
 * lib/providers/ximalaya.js — 喜马拉雅 provider。
 *
 * 只是把 lib/xmly.js 的协议函数收敛到一个统一接口（见 providers/index.js 的契约），
 * 协议细节仍然全部留在 xmly.js 里，既有单测继续覆盖。
 */

import {
  XmlyError,
  UA_WEB,
  joinCookieMap,
  searchAlbums,
  albumSimple,
  albumTracks,
  resolvePlay as xmlyResolvePlay,
  qrCreate as xmlyQrCreate,
  qrCheck as xmlyQrCheck,
  getCurrentUser,
  userFollowing,
  likeTracks,
  mySubscriptions,
  anchorProfile,
  listenedTracks,
  hotWords,
  rankBoards,
  rankTabs,
  rankElement,
  setSubscriptionAlbum,
  setLikeTrack,
  setFollow,
} from '../xmly.js'

const errorInfo = (err) => ({
  status: err instanceof XmlyError ? err.status : 500,
  message: String((err && err.message) || err),
  needLogin: err instanceof XmlyError && (err.code === 'NEED_AUTH' || err.code === 'NEED_LOGIN'),
  needVip: err instanceof XmlyError && err.code === 'NEED_AUTH',
})

export const ximalayaProvider = {
  id: 'ximalaya',
  label: '喜马拉雅',
  // 匿名即可搜索/浏览；播放免费内容也不需要登录，VIP/付费才需要。
  needsLogin: { search: false, browse: false, play: false, mine: true },
  supports: {
    following: true, likes: true, subscriptions: true, anchor: true, write: true, home: false,
    cloudFavs: false, cloudHistory: true,
    hotWords: true, ranks: true,
  },
  qrHint: '打开喜马拉雅 App →「我的」→ 右上角扫码',
  platformHint: '专辑页 URL 里 /album/<数字> 的编号',

  joinCookies: joinCookieMap,

  async qrCreate() {
    const session = await xmlyQrCreate()
    return { ...session, hint: this.qrHint }
  },

  async qrCheck(session) {
    const result = await xmlyQrCheck(session.qrId)
    if (result.status === 'success' && result.cookies) return { status: 'success', cookies: result.cookies }
    if (session.expiresAt && session.expiresAt < Date.now()) return { status: 'expired' }
    return { status: 'waiting' }
  },

  async user(cookie) {
    if (!cookie) return null
    return await getCurrentUser(cookie)
  },

  async search(kw, page = 1, size = 20) {
    return await searchAlbums(kw, page, size)
  },

  // ---- 发现：热搜词 / 排行榜（网页版 /ranking 同款，匿名可用）----
  async hotWords() {
    return await hotWords()
  },
  async ranks() {
    return await rankBoards()
  },
  // ---- 分类榜单（网页版 /top/<tabId>/<rankingId> 同款，需 xm-sign）----
  async rankCats() {
    return await rankTabs()
  },
  async rankContent(rankingId, pageNum) {
    return await rankElement(rankingId, pageNum)
  },

  async album(id) {
    return await albumSimple(id)
  },

  async tracks({ albumId, pageId = 1, pageSize = 30 }) {
    return await albumTracks(albumId, pageId, pageSize)
  },

  // 上一集 / 下一集：按 trackId 在专辑目录里翻页定位（最多翻 60 页 = 1800 集），
  // 找到后取 ±1；跨页时取相邻页的边界项。客户端没加载过那一页也能work。
  async neighbor({ albumId, trackId, dir = 1 }) {
    const id = Number(trackId)
    const step = Number(dir) >= 0 ? 1 : -1
    const pageSize = 30
    let lastOfPrevPage = null
    for (let page = 1; page <= 60; page += 1) {
      const res = await albumTracks(albumId, page, pageSize)
      const tracks = (res && res.tracks) || []
      if (tracks.length === 0) break
      const idx = tracks.findIndex((t) => Number(t.id) === id)
      if (idx >= 0) {
        const nextIdx = idx + step
        if (nextIdx >= 0 && nextIdx < tracks.length) {
          return { track: tracks[nextIdx], index: nextIdx, total: res.totalCount || 0 }
        }
        if (nextIdx < 0) {
          return { track: lastOfPrevPage, index: nextIdx, total: res.totalCount || 0 }
        }
        const more = await albumTracks(albumId, page + 1, pageSize)
        const nextTracks = (more && more.tracks) || []
        return { track: nextTracks[0] || null, index: nextIdx, total: res.totalCount || 0 }
      }
      lastOfPrevPage = tracks[tracks.length - 1]
      const maxPageId = (res && res.maxPageId) || 0
      if (maxPageId > 0 && page >= maxPageId) break
    }
    return { track: null, index: -1, total: 0 }
  },

  async resolvePlay({ trackId, cookie }) {
    return await xmlyResolvePlay(trackId, cookie || '')
  },

  streamHeaders() {
    return { 'user-agent': UA_WEB, referer: 'https://www.ximalaya.com/' }
  },

  // ---- 喜马拉雅独有：云端订阅/收藏/关注 ----
  async following(uid, page, pageSize, cookie) { return await userFollowing(uid, page, pageSize) },
  async likes(page, pageSize, cookie) { return await likeTracks(page, pageSize, cookie) },
  async subscriptions(page, pageSize, cookie) { return await mySubscriptions(page, pageSize, cookie) },
  async anchor(uid) { return await anchorProfile(uid) },

  /** 云端「听过」（/my/listened）：账号级，手机端听过的也在。 */
  async listened(cookie, { pageNum = 1 } = {}) {
    return await listenedTracks(pageNum, cookie)
  },
  async write(op, id, on, cookie) {
    if (op === 'sub') return await setSubscriptionAlbum(id, on, cookie)
    if (op === 'like') return await setLikeTrack(id, on, cookie)
    if (op === 'follow') return await setFollow(id, on, cookie)
    throw new XmlyError('不支持的 op（可用：sub / like / follow）', 'BAD_OP', 400)
  },

  errorInfo,
}
