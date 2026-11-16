/**
 * 懒人听书 provider 单元测试：全部走 stub fetch，不触网。
 * 覆盖真实接口的三种信封（成功 / 485 需登录 / 9999 未登录）、扫码登录、
 * 书目与章节目录的归一化、以及收听地址解析的权限分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  lrtsProvider, LrtsError, joinCookieMap, parseSetCookie, BASE, clearSectionCache,
} from '../lib/providers/lrts.js'

// ---- stub fetch：按用例改 nextBody（nextByPath 可以按 URL 片段分别给响应）----
let nextBody = null
let nextByPath = {}
let nextStatus = 200
let nextSetCookie = []
let calls = []

const makeRes = (body) => ({
  status: nextStatus,
  headers: {
    getSetCookie: () => nextSetCookie.slice(),
    get: (k) => (String(k).toLowerCase() === 'set-cookie' && nextSetCookie.length > 0 ? nextSetCookie.join(', ') : null),
  },
  text: async () => JSON.stringify(body === undefined ? nextBody : body),
})

beforeEach(() => {
  calls = []
  nextBody = { status: 0, msg: '', data: {} }
  nextByPath = {}
  nextStatus = 200
  nextSetCookie = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init: init || {} })
    const key = Object.keys(nextByPath).find((k) => u.includes(k))
    return makeRes(key ? nextByPath[key] : nextBody)
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const lastUrl = () => new URL(calls[calls.length - 1].url)

describe('lrts: cookie 工具', () => {
  it('parseSetCookie 处理 name=value; Path=/ 这类串', () => {
    const map = parseSetCookie(['a=1; Path=/; HttpOnly', 'b=2; Domain=.lrts.me', 'bad'])
    expect(map).toEqual({ a: '1', b: '2' })
  })

  it('joinCookieMap 拼回 Cookie 头', () => {
    expect(joinCookieMap({ a: '1', b: '2' })).toBe('a=1; b=2')
    expect(joinCookieMap({})).toBe('')
  })
})

describe('lrts: 请求信封', () => {
  it('未登录（485）翻译成 NEED_AUTH / 401', async () => {
    nextBody = { apiStatus: 485, status: 485, msg: '你好，需要登录才能继续使用此功能' }
    // 有 cookie 才会真的发请求，所以这里直接给个假 cookie。
    await expect(lrtsProvider.search('三体', 1, 20, 'x=1')).rejects.toMatchObject({
      code: 'NEED_AUTH', status: 401,
    })
  })

  it('未登录（9999）翻译成 NOLOGIN / 401', async () => {
    nextBody = { status: 9999, msg: '请先登录' }
    await expect(lrtsProvider.user('x=1')).resolves.toBeNull() // user() 吞掉未登录
    await expect(lrtsProvider.album(84, 'x=1')).rejects.toMatchObject({ code: 'NOLOGIN' })
  })

  it('其他错误码保留上游 msg', async () => {
    nextBody = { status: 2, msg: '系统异常' }
    await expect(lrtsProvider.album(84)).rejects.toMatchObject({ code: 'API_RET', status: 502, message: '系统异常' })
  })

  it('GET 带 _t 时间戳，POST 带 JSON body', async () => {
    nextBody = { apiStatus: 0, data: { detail: { id: 84, name: 'x' } } }
    await lrtsProvider.album(84)
    expect(lastUrl().searchParams.get('id')).toBe('84')
    expect(lastUrl().searchParams.get('_t')).toBeTruthy()
    expect(calls[0].url.startsWith(BASE + '/api/book/detail')).toBe(true)
  })
})

describe('lrts: 扫码登录', () => {
  it('qrCreate 生成 sceneToken + 自渲染二维码', async () => {
    nextBody = { status: 0, data: { sceneToken: 'abc123', expireAt: 1794756240 } }
    const s = await lrtsProvider.qrCreate()
    expect(s.sceneToken).toBe('abc123')
    // expireAt 可能是秒，也可能已经是毫秒：两种都要正确归一化。
    expect(s.expiresAt).toBe(1794756240 * 1000)
    expect(s.payload).toBe('https://m.lrts.me/activity/webQrLogin/index?sceneToken=abc123')
    expect(s.imageDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(s.imageDataUrl.length).toBeGreaterThan(1000)
    expect(calls[0].init.method).toBe('POST')
  })

  it('qrCreate 毫秒级 expireAt 原样保留', async () => {
    const ms = Date.now() + 300000
    nextBody = { status: 0, data: { sceneToken: 'tk', expireAt: ms } }
    const s = await lrtsProvider.qrCreate()
    expect(s.expiresAt).toBe(ms)
  })

  it('qrCreate 缺 sceneToken 报 BAD_RESPONSE', async () => {
    nextBody = { status: 0, data: {} }
    await expect(lrtsProvider.qrCreate()).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('qrCheck waiting', async () => {
    nextBody = { apiStatus: 0, status: 0, data: { status: 'waiting' } }
    const r = await lrtsProvider.qrCheck({ sceneToken: 'tk' })
    expect(r.status).toBe('waiting')
    expect(lastUrl().pathname).toBe('/api/user/webQrStatus')
    expect(JSON.parse(calls[0].init.body)).toEqual({ sceneToken: 'tk' })
  })

  it('qrCheck success 时带上 Set-Cookie', async () => {
    nextBody = { apiStatus: 0, status: 0, data: { status: 'success', user: { nickName: '听友' } } }
    nextSetCookie = ['token=deadbeef; Path=/', 'uid=42; Path=/']
    const r = await lrtsProvider.qrCheck({ sceneToken: 'tk' })
    expect(r.status).toBe('success')
    expect(r.cookies).toEqual({ token: 'deadbeef', uid: '42' })
    expect(r.user).toEqual({ nickName: '听友' })
  })

  it('qrCheck 过期 → expired', async () => {
    nextBody = { apiStatus: 0, status: 0, data: { status: 'expired' } }
    await expect(lrtsProvider.qrCheck({ sceneToken: 'tk' })).resolves.toMatchObject({ status: 'expired' })
  })

  it('qrCheck 没有 session 直接 expired，不发请求', async () => {
    await expect(lrtsProvider.qrCheck(null)).resolves.toMatchObject({ status: 'expired' })
    expect(calls.length).toBe(0)
  })
})

describe('lrts: 书目与章节', () => {
  it('album 归一化成喜马拉雅同款字段', async () => {
    nextBody = {
      apiStatus: 0,
      data: {
        detail: {
          id: 84, name: '史上第一混乱', author: '张小花', announcer: '有声刘忙',
          cover: 'https://bookpic.lrts.me/a.png', sections: 302, play: 231119442,
          type: '玄幻', listenPrice: '0', feeType: 0,
        },
      },
    }
    const a = await lrtsProvider.album(84)
    expect(a).toMatchObject({
      id: 84, title: '史上第一混乱', anchorName: '有声刘忙',
      trackCount: 302, playCount: 231119442, platform: 'lrts', isPaid: false,
    })
  })

  it('album 空 detail → NOT_FOUND', async () => {
    nextBody = { apiStatus: 0, data: {} }
    await expect(lrtsProvider.album(84)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('tracks 保留 section 供解析地址，付费章节标 isPaid', async () => {
    nextBody = {
      apiStatus: 0, data: null, sections: 2,
      list: [
        { id: 8400000001, sectionId: 8400000001, section: 1, name: '第001集', length: 1423, path: '', listenPrice: '0', feeType: 0, buy: 0, cantListen: 0, tmeId: '1036000702' },
        { id: 8400000002, sectionId: 8400000002, section: 2, name: '第002集', length: 1500, listenPrice: '10', feeType: 1, buy: 0, cantListen: 1, tmeId: '1036000703' },
      ],
    }
    clearSectionCache()
    const r = await lrtsProvider.tracks({ albumId: 84, pageId: 1, pageSize: 30 })
    expect(r.totalCount).toBe(2)
    expect(r.maxPageId).toBe(1)
    expect(r.truncated).toBe(false)
    // tmeId 必须透出来：它是 getListenPath 唯一认的播放凭据。
    expect(r.tracks[0]).toMatchObject({ id: 8400000001, section: 1, duration: 1423, isFree: true, tmeId: '1036000702' })
    expect(r.tracks[1].isPaid).toBe(true)
    expect(r.tracks[1].tmeId).toBe('1036000703')
  })

  it('tracks 一次取满后本地切片：服务端忽略 pageNo，翻页不能在客户端重复第一页', async () => {
    // 真实接口行为：pageNo/page/start/offset 全部无效，单次最多 1000 条。
    const list = Array.from({ length: 1000 }, (_, i) => ({
      id: 8400000001 + i, sectionId: 8400000001 + i, section: i + 1,
      name: '第' + String(i + 1).padStart(4, '0') + '集', length: 60, path: '',
      listenPrice: '0', feeType: 0, buy: 0, cantListen: 0,
    }))
    nextBody = { apiStatus: 0, data: null, sections: 502, list }
    clearSectionCache()

    const p1 = await lrtsProvider.tracks({ albumId: 777, pageId: 1, pageSize: 30 })
    expect(p1.totalCount).toBe(502)
    expect(p1.tracks.length).toBe(30)
    expect(p1.tracks[0]).toMatchObject({ id: 8400000001, section: 1 })
    expect(p1.maxPageId).toBe(Math.ceil(502 / 30))
    expect(p1.truncated).toBe(false)
    const p2 = await lrtsProvider.tracks({ albumId: 777, pageId: 2, pageSize: 30 })
    expect(p2.tracks[0].id).toBe(8400000031)
    expect(p2.tracks.length).toBe(30)
    // 第二次翻页命中目录缓存，不再打上游
    expect(calls.filter((c) => new URL(c.url).pathname === '/api/book/resource').length).toBe(1)
    const tail = await lrtsProvider.tracks({ albumId: 777, pageId: 17, pageSize: 30 })
    expect(tail.tracks.length).toBe(22)
    expect(tail.tracks[0].id).toBe(8400000481)
  })

  it('tracks 章节数超过单次上限时标 truncated，提示只拿到前 1000 章', async () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, section: i + 1, name: 'x' + i }))
    nextBody = { apiStatus: 0, data: null, sections: 4775, list }
    clearSectionCache()
    const r = await lrtsProvider.tracks({ albumId: 888, pageId: 1, pageSize: 30 })
    expect(r.totalCount).toBe(4775)
    expect(r.truncated).toBe(true)
    expect(r.maxPageId).toBe(Math.ceil(1000 / 30))
  })

  it('tracks force=1 绕过目录缓存', async () => {
    nextBody = { apiStatus: 0, data: null, sections: 1, list: [{ id: 1, section: 1, name: 'a' }] }
    clearSectionCache()
    await lrtsProvider.tracks({ albumId: 999, pageId: 1, pageSize: 30 })
    await lrtsProvider.tracks({ albumId: 999, pageId: 1, pageSize: 30, force: true })
    expect(calls.filter((c) => new URL(c.url).pathname === '/api/book/resource').length).toBe(2)
  })
})

describe('lrts: 云端收藏', () => {
  it('未登录直接 NEED_AUTH，不发请求', async () => {
    await expect(lrtsProvider.collections('')).rejects.toMatchObject({ code: 'NEED_AUTH', status: 401 })
    expect(calls.length).toBe(0)
  })

  it('getCollectionBooks 一次取回全部，过滤已取消项并归一化', async () => {
    nextBody = {
      apiStatus: 0,
      data: {
        list: [
          { bookId: 84, name: '史上第一混乱', announcer: '有声刘忙', cover: 'c.png', sections: 302, play: 231119442, listenPrice: '0', feeType: 0, updateState: 0 },
          { bookId: 85, name: '已取消收藏的书', updateState: 2 },
          { bookId: 0, name: '脏数据' },
        ],
      },
    }
    const r = await lrtsProvider.collections('x=1')
    expect(r.albums.length).toBe(1)
    expect(r.albums[0]).toMatchObject({
      id: 84, title: '史上第一混乱', anchorName: '有声刘忙', trackCount: 302, platform: 'lrts',
    })
    const sent = JSON.parse(calls[calls.length - 1].init.body)
    expect(sent).toEqual({ ids: '0' })
    expect(new URL(calls[calls.length - 1].url).pathname).toBe('/api/collection/getCollectionBooks')
  })
})

describe('lrts: 云端收听记录（我的→历史）', () => {
  it('未登录直接 NEED_AUTH，不发请求', async () => {
    await expect(lrtsProvider.listened('')).rejects.toMatchObject({ code: 'NEED_AUTH', status: 401 })
    expect(calls.length).toBe(0)
  })

  it('getRecentListenBooks 归一化成续播条目（listpos/playpos/duration）', async () => {
    nextBody = {
      status: 0, apiStatus: 0, msg: '', referId: '1794759908249_1794846308249',
      list: [
        {
          name: '神秘复苏', shortName: '神秘复苏', bookId: 49065178, sonId: 4906517800010803,
          resourceName: '神秘复苏 第803集 助理李瑶', announcer: '曾中人有故事', cover: 'https://bookpic.lrts.me/x.png',
          listpos: 803, playpos: 305, duration: 362, lastListenTime: 1794760180000, date: '2026-11-16 00:29:40', isDelete: 0,
        },
        { name: '已删除的书', bookId: 1, sonId: 2, isDelete: 1 },
      ],
    }
    const r = await lrtsProvider.listened('x=1', { pageSize: 30 })
    expect(r.items.length).toBe(1)
    expect(r.items[0]).toMatchObject({
      trackId: 4906517800010803,
      trackTitle: '神秘复苏 第803集 助理李瑶',
      albumId: 49065178,
      albumTitle: '神秘复苏',
      anchorName: '曾中人有故事',
      section: 803,
      position: 305,
      duration: 362,
    })
    expect(r.referId).toBe('1794759908249_1794846308249')
    // 游标翻页的尽头判定：不满一页 → false（这是全部）。
    expect(r.hasMore).toBe(false)
    const u = lastUrl()
    expect(u.pathname).toBe('/api/collection/getRecentListenBooks')
    expect(u.searchParams.get('srcType')).toBe('101')
  })

  it('传 referId 时带上游标', async () => {
    nextBody = { status: 0, list: [], referId: 'next' }
    await lrtsProvider.listened('x=1', { referId: 'abc' })
    expect(lastUrl().searchParams.get('referId')).toBe('abc')
  })

  it('一页拉满 pageSize → hasMore=true（referId 游标还能继续翻）', async () => {
    nextBody = {
      status: 0, referId: 'cursor-2',
      list: Array.from({ length: 5 }, (_, i) => ({
        name: '书' + i, bookId: 100 + i, sonId: 1000 + i, listpos: i + 1,
        playpos: 0, duration: 60, isDelete: 0,
      })),
    }
    const r = await lrtsProvider.listened('x=1', { pageSize: 5 })
    expect(r.items.length).toBe(5)
    expect(r.hasMore).toBe(true)
  })
})

describe('lrts: 收听地址', () => {
  it('匿名解析直接 NEED_AUTH（连免费章节也要登录）', async () => {
    await expect(lrtsProvider.resolvePlay({ trackId: 1, albumId: 84, section: 1 }))
      .rejects.toMatchObject({ code: 'NEED_AUTH' })
    expect(calls.length).toBe(0)
  })

  it('缺 albumId/section → BAD_ARGS', async () => {
    await expect(lrtsProvider.resolvePlay({ trackId: 1, cookie: 'x=1' }))
      .rejects.toMatchObject({ code: 'BAD_ARGS', status: 400 })
  })

  it('tmeId 才是播放凭据：trackId/resId 传 tmeId 并拿回直链', async () => {
    nextBody = { status: 0, data: { path: 'https://audio.lrts.me/84/1.m4a', duration: 1423 } }
    const r = await lrtsProvider.resolvePlay({ trackId: 8400000001, tmeId: '1036000702', albumId: 84, section: 1, cookie: 'x=1' })
    expect(r.url).toBe('https://audio.lrts.me/84/1.m4a')
    expect(r.duration).toBe(1423)
    const u = lastUrl()
    expect(u.pathname).toBe('/api/gateway/getListenPath')
    expect(u.searchParams.get('entityType')).toBe('1')
    expect(u.searchParams.get('entityId')).toBe('84')
    expect(u.searchParams.get('section')).toBe('1')
    // 关键：传的是 tmeId，不是 sectionId（传 sectionId 会拿到 status:20 空 path）
    expect(u.searchParams.get('trackId')).toBe('1036000702')
    expect(u.searchParams.get('resId')).toBe('1036000702')
  })

  it('没带 tmeId 时按 albumId+section 回查目录拿 tmeId', async () => {
    clearSectionCache()
    nextByPath = {
      '/api/book/resource': {
        status: 0, apiStatus: 0, sections: 1,
        list: [{ id: 8400000001, sectionId: '8400000001', section: 1, name: '第001集', tmeId: '1036000702' }],
      },
      '/api/gateway/getListenPath': { status: 0, data: { path: 'https://audio.lrts.me/84/1.m4a' } },
    }
    const r = await lrtsProvider.resolvePlay({ trackId: 8400000001, albumId: 84, section: 1, cookie: 'x=1' })
    expect(r.url).toBe('https://audio.lrts.me/84/1.m4a')
    expect(calls.length).toBe(2)
    expect(lastUrl().searchParams.get('trackId')).toBe('1036000702')
  })

  it('既没 tmeId 又查不到 → BAD_ARGS（而不是谎报 VIP）', async () => {
    clearSectionCache()
    nextByPath = {
      '/api/book/resource': { status: 0, apiStatus: 0, sections: 0, list: [] },
    }
    await expect(lrtsProvider.resolvePlay({ trackId: 1, albumId: 777, section: 5, cookie: 'x=1' }))
      .rejects.toMatchObject({ code: 'BAD_ARGS', status: 400 })
  })

  it('已登录但 path 为空 → NEED_VIP（会员/付费未开通）', async () => {
    nextBody = { status: 0, data: { path: '' } }
    await expect(lrtsProvider.resolvePlay({ trackId: 8400000001, tmeId: '1036000702', albumId: 84, section: 1, cookie: 'x=1' }))
      .rejects.toMatchObject({ code: 'NEED_VIP', status: 403 })
  })

  it('status:20（资源号无效）给出可读错误，不当成 VIP 权限问题', async () => {
    nextBody = { status: 20, apiStatus: 20, msg: '', data: null }
    await expect(lrtsProvider.resolvePlay({ trackId: 8400000001, tmeId: 'bad', albumId: 84, section: 1, cookie: 'x=1' }))
      .rejects.toMatchObject({ code: 'API_RET', status: 502 })
  })
})

describe('lrts: 其他', () => {
  it('search 没有 cookie 直接拒绝，不发请求', async () => {
    await expect(lrtsProvider.search('三体')).rejects.toMatchObject({ code: 'NEED_AUTH' })
    expect(calls.length).toBe(0)
  })

  it('search 归一化 bookAlbums', async () => {
    nextBody = {
      status: 0,
      data: { total: 2, bookAlbums: [{ id: 1, name: '三体', announcer: '播讲' }, { id: 2, name: '三体Ⅱ' }] },
    }
    const r = await lrtsProvider.search('三体', 1, 20, 'x=1')
    expect(r.albums.length).toBe(2)
    expect(r.albums[0]).toMatchObject({ id: 1, title: '三体', platform: 'lrts' })
    expect(r.total).toBe(2)
  })

  it('home 从 recommendEntityList 里取书目（登录前可逛）', async () => {
    nextBody = {
      status: 0,
      data: {
        recommendEntityList: [
          { id: 9, type: 1, bookAlbum: { id: 84, name: '史上第一混乱', cover: 'c.png', announcer: '有声刘忙' } },
          { id: 10, type: 2 },
        ],
      },
    }
    const r = await lrtsProvider.home('')
    expect(r.albums.length).toBe(1)
    expect(r.albums[0].title).toBe('史上第一混乱')
  })

  it('rankCats 拉取 groupList 分组并过滤主播榜（rankType 6）', async () => {
    nextBody = {
      status: 0,
      data: {
        list: [
          {
            rankingsGroupInfoView: { name: '全部' },
            rankingsList: [
              { rankId: 75, rankName: '热播榜', rankType: 0 },
              { rankId: 265, rankName: '畅销榜', rankType: 0 },
            ],
          },
          {
            rankingsGroupInfoView: { name: '主播' },
            rankingsList: [{ rankId: 297, rankName: '主播榜', rankType: 6 }],
          },
        ],
      },
    }
    const r = await lrtsProvider.rankCats()
    expect(lastUrl().pathname).toBe('/api/ranking/groupList')
    expect(lastUrl().searchParams.get('groupId')).toBe('0')
    expect(lastUrl().searchParams.get('groupType')).toBe('1')
    expect(r.tabs.length).toBe(1) // 主播组（rankType 6）被过滤
    expect(r.tabs[0].name).toBe('全部')
    expect(r.tabs[0].wraps.map((w) => w.name)).toEqual(['热播榜', '畅销榜'])
    expect(r.tabs[0].wraps[0].rankingId).toBe(75)
  })

  it('rankCats 拉取失败时回退到「排行榜」单组 9 张榜', async () => {
    nextBody = { status: 2, msg: '榜单已下线' }
    const r = await lrtsProvider.rankCats()
    expect(r.tabs.length).toBe(1)
    expect(r.tabs[0].name).toBe('排行榜')
    expect(r.tabs[0].wraps.length).toBe(9)
    expect(r.tabs[0].wraps.map((w) => w.name)).toEqual([
      '热播榜', '畅销榜', '新书榜', '热搜榜', '好评榜', '收藏榜', '完结榜', '免费榜', '会员榜',
    ])
  })

  it('rankContent 归一化榜单条目（playCount 取 hot，rangeType=3 取总榜）', async () => {
    nextBody = {
      status: 0,
      data: {
        rankName: '热播榜',
        list: [
          { id: 84, name: '史上第一混乱', announcer: '有声刘忙', cover: 'c.png', hot: 231119442, sections: 302 },
        ],
      },
    }
    const r = await lrtsProvider.rankContent(75)
    expect(r.title).toBe('热播榜')
    expect(r.albums.length).toBe(1)
    expect(r.albums[0]).toMatchObject({ id: 84, title: '史上第一混乱', playCount: 231119442, trackCount: 302 })
    expect(lastUrl().pathname).toBe('/api/ranking/resList')
    expect(lastUrl().searchParams.get('rankId')).toBe('75')
    expect(lastUrl().searchParams.get('rangeType')).toBe('3')
    expect(lastUrl().searchParams.get('pageSize')).toBe('100')
  })

  it('rankContent 传非法 id → BAD_ARGS（不触网）', async () => {
    await expect(lrtsProvider.rankContent(0)).rejects.toMatchObject({ code: 'BAD_ARGS' })
    expect(calls.length).toBe(0)
  })

  it('rankContent 未知榜 id → 服务端 status:2 → API_RET', async () => {
    nextBody = { status: 2, msg: '榜单已下线' }
    await expect(lrtsProvider.rankContent(999)).rejects.toMatchObject({ code: 'API_RET', status: 502 })
  })

  it('streamHeaders 带上 UA 与 Referer', () => {
    const h = lrtsProvider.streamHeaders()
    expect(h['user-agent']).toBeTruthy()
    expect(h.referer).toBe(BASE + '/')
  })

  it('errorInfo 区分 needLogin / needVip', () => {
    expect(lrtsProvider.errorInfo(new LrtsError('x', 'NEED_AUTH', 401))).toMatchObject({ needLogin: true, status: 401 })
    expect(lrtsProvider.errorInfo(new LrtsError('x', 'NEED_VIP', 403))).toMatchObject({ needVip: true, status: 403 })
    expect(lrtsProvider.errorInfo(new Error('boom'))).toMatchObject({ needLogin: false, needVip: false, status: 500 })
  })
})

describe('lrts: 会员（VIP）状态', () => {
  // 懒人听书 getUserInfo 没有 isVip 字段，会员靠 vipExpireTime（毫秒时间戳）+ timeRemaining（天数）。
  const DAY = 86400000

  it('vipExpireTime 是毫秒时间戳 → 算出剩余天数与到期时间', async () => {
    const expire = Date.now() + 368 * DAY
    nextBody = {
      status: 0,
      data: {
        userId: 692602112, nickname: 'fyxsky', cover: 'head.png',
        vipExpireTime: expire, vipBuyExpireTime: expire, vipExpireTimeNonExperience: expire,
        timeRemaining: 368, vipType: 0, feeType: 3,
      },
    }
    const user = await lrtsProvider.user('wsid=abc')
    expect(user.isVip).toBe(true)
    expect(user.vipUntil).toBe(expire)
    expect(user.vipDays).toBeGreaterThanOrEqual(367)
    expect(user.vipDays).toBeLessThanOrEqual(369)
    expect(user.nickname).toBe('fyxsky')
    // 头像字段叫 cover，之前取不到
    expect(user.avatar).toBe('head.png')
  })

  it('vipType>0 时带上等级', async () => {
    nextBody = {
      status: 0,
      data: { userId: 1, nickname: 'vip', vipExpireTime: Date.now() + 10 * DAY, vipType: 2, timeRemaining: 10 },
    }
    const user = await lrtsProvider.user('wsid=abc')
    expect(user.isVip).toBe(true)
    expect(user.vipLevel).toBe(2)
  })

  it('只有 timeRemaining（没有时间戳）也算会员', async () => {
    nextBody = { status: 0, data: { userId: 2, nickname: 'days', timeRemaining: 12 } }
    const user = await lrtsProvider.user('wsid=abc')
    expect(user.isVip).toBe(true)
    expect(user.vipDays).toBe(12)
    expect(user.vipUntil).toBe(0)
  })

  it('已过期 → 普通账号（不把过期时间当成会员）', async () => {
    nextBody = {
      status: 0,
      data: { userId: 3, nickname: 'old', vipExpireTime: Date.now() - 5 * DAY, timeRemaining: 0, feeType: 0 },
    }
    const user = await lrtsProvider.user('wsid=abc')
    expect(user.isVip).toBe(false)
    expect(user.vipDays).toBe(0)
    expect(user.vipUntil).toBe(0)
    expect(user.vipLevel).toBe(0)
  })

  it('没有任何会员字段 → isVip false', async () => {
    nextBody = { status: 0, data: { userId: 4, nickname: 'plain' } }
    const user = await lrtsProvider.user('wsid=abc')
    expect(user.isVip).toBe(false)
    expect(user.vipDays).toBe(0)
  })
})

describe('lrts: 上一集 / 下一集（neighbor）', () => {
  const chapters = [
    { id: 8400000001, sectionId: 8400000001, section: 1, name: '第001集', length: 600, tmeId: '111' },
    { id: 8400000002, sectionId: 8400000002, section: 2, name: '第002集', length: 601, tmeId: '222' },
    { id: 8400000003, sectionId: 8400000003, section: 3, name: '第003集', length: 602, tmeId: '333' },
  ]
  const resource = { apiStatus: 0, status: 0, bookId: 84, sections: 3, userType: 0, list: chapters }

  it('按 section 定位相邻章节（不依赖客户端已加载的分页）', async () => {
    clearSectionCache()
    nextByPath = { '/api/book/resource': resource }
    const out = await lrtsProvider.neighbor({ albumId: 84, section: 2, dir: 1 })
    expect(out.track).toMatchObject({ section: 3, tmeId: '333' })
    expect(out.index).toBe(2)
    expect(out.total).toBe(3)
  })

  it('第一集点「上一集」→ track=null（UI 提示已经是第一集）', async () => {
    clearSectionCache()
    nextByPath = { '/api/book/resource': resource }
    const out = await lrtsProvider.neighbor({ albumId: 84, section: 1, dir: -1 })
    expect(out.track).toBeNull()
    expect(out.index).toBe(-1)
  })

  it('没有 section 时用 trackId（sectionId）兜底定位', async () => {
    clearSectionCache()
    nextByPath = { '/api/book/resource': resource }
    const out = await lrtsProvider.neighbor({ albumId: 84, trackId: '8400000002', dir: 1 })
    expect(out.track).toMatchObject({ section: 3 })
  })

  it('缺少 albumId → BAD_ARGS', async () => {
    await expect(lrtsProvider.neighbor({ trackId: '1', dir: 1 })).rejects.toThrow(/专辑 id/)
  })
})
