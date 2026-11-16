/**
 * lib/providers/index.js — 平台注册表。
 *
 * 「听说平台」抽象：每个 provider 提供同一套方法，宿主（lib/index.js）与浏览器
 * （lib/client.js）只依赖这套契约，不关心背后是喜马拉雅还是懒人听书。
 *
 * 契约（全部 async，cookie 一律是拼好的 Cookie 头字符串）：
 *   id / label / needsLogin{search,browse,play,mine} / supports{...} / qrHint / platformHint
 *   qrCreate()                              -> {imageDataUrl, expiresAt, hint, ...}
 *   qrCheck(session)                        -> {status:'waiting'|'success'|'expired', cookies?, user?}
 *   logout()                                -> void（尽力而为）
 *   user(cookie)                            -> {uid,nickname,avatar,isVip,...}|null
 *   search(kw, page, size, cookie)          -> {albums, total, page, totalPages}
 *   album(id, cookie)                       -> album
 *   tracks({albumId, pageId, pageSize, cookie}) -> {tracks, totalCount, pageId, maxPageId, truncated?}
 *   resolvePlay({trackId, albumId, section, cookie}) -> {url, quality, source, title, duration}
 *   streamHeaders()                         -> 回源请求头（Referer/UA）
 *   errorInfo(err)                          -> {status, message, needLogin, needVip}
 *   joinCookies(map)                        -> 'k=v; k2=v2'
 * 可选：home(cookie)、following/likes/subscriptions/anchor/write、collections(cookie)、
 *       listened(cookie, {pageNum, pageSize, referId}) -> {items, totalCount, referId, hasMore}、
 *       hotWords() -> {hots:[...]}、ranks() -> {boards:[{rankId,title,subtitle,albums}]}、
 *       rankCats() -> {tabs:[{id,name,wraps:[{id,name,rankingId}]}]}、
 *       rankContent(rankingId[, pageNum]) -> {rankingId,title,subtitle,count,albums}，
 *       能力由 supports 里的 home/following/likes/subscriptions/anchor/write/cloudFavs/cloudHistory/hotWords/ranks 声明。
 *
 * 分类榜单：喜马拉雅 rankCats() 返回 19 个一级分类（含「小说」等），每个分类的
 * wraps 是子榜单（小说下含 玄幻/悬疑/历史/科幻/游戏/现言/古言/幻言/悬爱 等），
 * rankContent(rankingId) 取单个子榜单内容（**不带 pageNum 时服务端返回完整榜单 Top100**；
 * pageNum 是「返回条数」且硬上限 10，一般不必传）；
 * 懒人听书 rankCats() 动态拉取 groupList（分组 → 榜单两级，只保留书籍/专辑榜 rankType 0；
 * 主播榜 rankType 6 是播主榜走 announcerList，不在听书榜单范围内），拉不到时回退到
 * 「全部」组 9 张榜；rankContent(rankingId) 用 rangeType=3&pageSize=100 各取 Top100。
 *
 * 收听历史：两平台都是账号级云端接口（喜马拉雅 getListened「听过」、懒人听书
 * getRecentListenBooks「收听记录」），由 provider.listened() 提供，能力位
 * supports.cloudHistory —— 手机端听过的也会出现在这里。
 */

import { ximalayaProvider } from './ximalaya.js'
import { lrtsProvider } from './lrts.js'

export const PROVIDERS = {
  ximalaya: ximalayaProvider,
  lrts: lrtsProvider,
}

export const PLATFORM_IDS = Object.keys(PROVIDERS)
export const DEFAULT_PLATFORM = 'ximalaya'

export const isPlatform = (value) => typeof value === 'string' && Object.hasOwn(PROVIDERS, value)

/** 非法/缺失平台名一律回落到默认平台（路由层需要区分时先调用 isPlatform）。 */
export const providerOf = (id) => (isPlatform(id) ? PROVIDERS[id] : PROVIDERS[DEFAULT_PLATFORM])

/** 给浏览器清单用的平台元信息（不含任何账号数据）。 */
export const platformsMeta = () => PLATFORM_IDS.map((id) => {
  const p = PROVIDERS[id]
  return {
    id,
    label: p.label,
    needsLogin: p.needsLogin,
    supports: p.supports,
    qrHint: p.qrHint,
    platformHint: p.platformHint,
  }
})

export const labelOf = (id) => providerOf(id).label
