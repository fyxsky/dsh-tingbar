/**
 * host 半边路由集成测试：起一个真实 http server，挂载 apply() 的 handler，
 * 验证 JSON 路由的鉴权/校验/错误处理（触网的搜索/播放用 stub 替换）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试写到隔离的临时 DSH_HOME，避免污染真实 ~/.dsh/tingbar-state.json。
// （必须在导入 lib/index.js 之前设置）
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-tingbar-test-'))
process.env.DSH_HOME = tmpHome

// stub 掉真实网络模块（避免测试依赖外网）。
vi.mock('../lib/xmly.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    searchAlbums: vi.fn(async (kw) => ({
      albums: [{
        id: 123, title: '测试专辑', intro: '', cover: '', trackCount: 3,
        anchorName: '主播', category: '测试', isPaid: false, isFinished: true,
        playCount: 10, createdAt: 0, updatedAt: 0, tags: [],
      }],
      total: 1, page: 1, totalPages: 1,
    })),
    albumSimple: vi.fn(async (id) => ({ id: Number(id), title: '测试专辑', anchorName: '主播', cover: '', category: '测试', isPaid: false, isFinished: true, intro: '' })),
    albumTracks: vi.fn(async (id, pageId) => ({
      tracks: [
        { id: 1001, title: '第一集', duration: 60, createdAt: 0, isPaid: false, isFree: true, isAuthorized: true, playCount: 1, comments: 0, likes: 0, orderNo: 1, cover: '', anchorName: '', albumTitle: '测试专辑', intro: '' },
        { id: 1002, title: '第二集', duration: 60, createdAt: 0, isPaid: false, isFree: true, isAuthorized: true, playCount: 1, comments: 0, likes: 0, orderNo: 2, cover: '', anchorName: '', albumTitle: '测试专辑', intro: '' },
      ],
      maxPageId: 1, totalCount: 2, pageId,
    })),
    resolvePlay: vi.fn(async () => ({ url: 'https://example.com/a.m4a', quality: '标准 64kbps M4A', source: 'trackJson', title: '第一集', duration: 60 })),
    qrCreate: vi.fn(async () => ({ qrId: 'QRID', imageDataUrl: 'data:image/png;base64,xxx', expiresAt: Date.now() + 180000 })),
    qrCheck: vi.fn(async () => ({ status: 'waiting', cookies: null })),
    getCurrentUser: vi.fn(async () => null),
    userFollowing: vi.fn(async (uid, page = 1, pageSize = 20) => ({
      anchors: [
        { uid: 170217760, nickname: '三体宇宙', cover: '', description: '三体有声剧官方', ptitle: '', albumCount: 11, trackCount: 488, fansCount: 4725762, followingCount: 22, isFollow: true, url: '/zhubo/170217760' },
        { uid: 2, nickname: '喜马拉雅创作中心', cover: '', description: '', ptitle: '喜马拉雅', albumCount: 776, trackCount: 101161, fansCount: 27105024, followingCount: 152, isFollow: true, url: '/zhubo/2' },
      ],
      total: 2, page, pageSize,
    })),
    likeTracks: vi.fn(async (pageNum = 1, pageSize = 30) => ({
      tracks: [
        { id: 1001, title: '收藏的第一集', cover: '', duration: 258, durationText: '04:18', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 10, createdAtText: '3天前', isVideo: false, isPaid: false },
        { id: 1002, title: '收藏的第二集', cover: '', duration: 0, durationText: '', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 5, createdAtText: '', isVideo: false, isPaid: true },
      ],
      total: 2, pageNum, hasMore: true,
    })),
    mySubscriptions: vi.fn(async (page = 1, pageSize = 30) => ({
      albums: [
        { id: 323366, title: '订阅的测试专辑', intro: '', cover: 'https://imagev2.xmcdn.com/storages/x.jpeg', trackCount: 2300, playCount: 175044737, isPaid: false, isFinished: false, anchorName: '詩展', anchorUid: 6042491, category: '历史', score: '9.6', lastTrackTitle: '最新一集', lastUpdateText: '1天前' },
      ],
      total: 1, page, hasMore: false,
    })),
    anchorProfile: vi.fn(async (uid) => ({
      albums: [
        { id: 111, title: '主播专辑一', cover: '', intro: '', trackCount: 10, playCount: 100, isPaid: false, isFinished: true, anchorName: '三体宇宙' },
        { id: 222, title: '主播专辑二（付费）', cover: '', intro: '', trackCount: 20, playCount: 200, isPaid: true, isFinished: false, anchorName: '三体宇宙' },
      ],
      total: 2, uid,
    })),
    setSubscriptionAlbum: vi.fn(async (albumId, on) => ({ msg: on ? '订阅专辑成功' : '取消订阅专辑成功' })),
    setLikeTrack: vi.fn(async (trackId, on) => ({ msg: on ? '点赞成功' : '取消点赞成功' })),
    setFollow: vi.fn(async (uid, on) => ({ msg: on ? 'isFollow' : '成功取消关注' })),
    // 云端「听过」：真实实现按 today/yesterday/earlier 分组，这里给两条即可。
    listenedTracks: vi.fn(async (pageNum = 1) => ({
      items: [
        { trackId: 1017788628, trackTitle: '听过第一集', albumId: 130106749, albumTitle: '听过的专辑', anchorName: '主播', cover: 'https://imagev2.xmcdn.com/x.png', duration: 355, position: 0, section: null, updatedAt: 1794565087823, updatedText: '2天前', group: '更早' },
        { trackId: 1017788629, trackTitle: '听过第二集', albumId: 130106749, albumTitle: '听过的专辑', anchorName: '主播', cover: '', duration: 300, position: 0, section: null, updatedAt: 1794565087000, updatedText: '2天前', group: '更早' },
      ],
      totalCount: 283,
      page: pageNum,
      // 与真实上游一致：getListened 不翻页，一次给全 → hasMore 恒 false。
      hasMore: false,
    })),
    // 热搜词（网页版搜索框下拉同款）。
    hotWords: vi.fn(async () => ({
      hots: ['郭德纲相声', '三体', '凡人修仙传'],
    })),
    // 排行榜（网页版 /ranking 同款 /revision/rank/v2/element）。
    rankBoards: vi.fn(async () => ({
      boards: [
        {
          rankId: 163, title: '经典免费榜', subtitle: '80%的用户都在听的好内容', count: 100,
          albums: [
            { id: 30140766, title: '辽沈晚报', intro: '', cover: 'https://imagev2.xmcdn.com/x.jpg', trackCount: 4984, playCount: 682485553, isPaid: false, isFinished: false, anchorName: '辽沈晚报', category: '其他', lastUpdateText: '' },
            { id: 9723091, title: '百家讲坛', intro: '', cover: '', trackCount: 100, playCount: 100, isPaid: false, isFinished: false, anchorName: '央视', category: '人文', lastUpdateText: '' },
          ],
        },
      ],
      updatedAt: 1794760000000,
    })),
    // 分类榜单：一级分类树 + 单个榜单内容（网页版 /top/<tabId>/<rankingId> 同款）。
    rankTabs: vi.fn(async () => ({
      tabs: [
        { id: 1, name: '全站', wraps: [{ id: 100001, name: '热播', rankingId: 100001 }] },
        { id: 2, name: '小说', wraps: [{ id: 100168, name: '热播', rankingId: 100168 }, { id: 100079, name: '玄幻', rankingId: 100079 }] },
      ],
      updatedAt: 1794760000000,
    })),
    rankElement: vi.fn(async (rankingId, pageNum) => ({
      rankingId: Number(rankingId),
      title: '小说 · 热播榜',
      subtitle: '',
      count: Number(pageNum) || 10,
      albums: [
        { id: 40121646, title: '三体（全集）', intro: '', cover: 'https://imagev2.xmcdn.com/x.jpg', trackCount: 313, playCount: 123456789, isPaid: true, isFinished: false, anchorName: '三体宇宙', category: '小说', lastUpdateText: '' },
      ],
    })),
  }
})

// stub 懒人听书的榜单接口（避免 host 集成测试触网；其余 lrts 方法走真实实现）。
vi.mock('../lib/providers/lrts.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    lrtsProvider: {
      ...real.lrtsProvider,
      rankCats: vi.fn(async () => ({
        tabs: [
          { id: 1, name: '全部', wraps: [{ id: 75, name: '热播榜', rankingId: 75 }, { id: 265, name: '畅销榜', rankingId: 265 }] },
          { id: 2, name: '出版', wraps: [{ id: 14454, name: '热播榜', rankingId: 14454 }] },
        ],
        updatedAt: 1794760000000,
      })),
      rankContent: vi.fn(async (rankingId) => ({
        rankingId: Number(rankingId),
        title: '热播榜',
        subtitle: '',
        count: 100,
        albums: [
          { id: 84, title: '史上第一混乱', intro: '', cover: 'https://bookpic.lrts.me/x.png', trackCount: 302, playCount: 231119442, isPaid: false, isFinished: false, anchorName: '有声刘忙', category: '玄幻', platform: 'lrts' },
        ],
      })),
    },
  }
})

import { apply } from '../lib/index.js'
import { qrCheck, getCurrentUser, listenedTracks, rankElement } from '../lib/xmly.js'

let server = null
let registeredTool = null
let promptSection = null
const cleanups = []
const base = 'http://127.0.0.1:18123'

beforeAll(async () => {
  let handler = null
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register: (reg) => { handler = reg.handler } },
    tools: { register: (t) => { registeredTool = t } },
    systemPrompt: { section: (s) => { promptSection = s } },
    shell: { run: async () => ({ stdout: { text: '' } }), resolve: (x) => x },
    fs: {},
  }
  apply(ctx)
  server = http.createServer(handler)
  await new Promise((r) => server.listen(18123, '127.0.0.1', r))
})
afterAll(async () => {
  for (const c of cleanups) { try { c() } catch {} }
  await new Promise((r) => server.close(r))
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

const get = async (path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return { status: res.status, body: await res.json() }
}

describe('host routes', () => {
  it('manifest 返回初始状态', async () => {
    const { status, body } = await get('/dsh-tingbar/manifest')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.loggedIn).toBe(false)
    expect(Array.isArray(body.favs)).toBe(true)
  })

  it('search 缺关键词 400', async () => {
    const { status, body } = await get('/dsh-tingbar/search')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('search 命中并记录历史', async () => {
    const { status, body } = await get('/dsh-tingbar/search?kw=' + encodeURIComponent('测试'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.albums[0].title).toBe('测试专辑')
    const m = await get('/dsh-tingbar/manifest')
    expect(m.body.history).toContain('测试')
  })

  it('album / tracks 路由', async () => {
    const a = await get('/dsh-tingbar/album?id=123')
    expect(a.body.album.title).toBe('测试专辑')
    const t = await get('/dsh-tingbar/tracks?albumId=123&pageId=1')
    expect(t.body.tracks.length).toBe(2)
    expect(t.body.totalCount).toBe(2)
  })

  it('play 返回 streamUrl', async () => {
    const p = await get('/dsh-tingbar/play?trackId=1001')
    expect(p.body.ok).toBe(true)
    expect(p.body.streamUrl).toBe('/dsh-tingbar/stream?trackId=1001')
    expect(p.body.quality).toContain('M4A')
  })

  it('play 缺 trackId 400', async () => {
    const { status } = await get('/dsh-tingbar/play')
    expect(status).toBe(400)
  })

  it('prefs 白名单过滤 + playback 快照', async () => {
    const w = await post('/dsh-tingbar/prefs', {
      prefs: { volume: 0.5, evil: 'hack' },
      playback: { albumId: 123, albumTitle: '测试专辑', trackId: 1001, trackTitle: '第一集', position: 12, duration: 60 },
    })
    expect(w.body.prefs.volume).toBe(0.5)
    expect(w.body.prefs.evil).toBeUndefined()
    expect(w.body.playback.trackId).toBe(1001)
    const r = await get('/dsh-tingbar/prefs')
    expect(r.body.prefs.volume).toBe(0.5)
    expect(r.body.playback.position).toBe(12)
  })

  it('prefs 持久化 seekStep（快进/快退步长），白名单外键仍被过滤', async () => {
    const w = await post('/dsh-tingbar/prefs', { prefs: { seekStep: 30, evil: 'hack' } })
    expect(w.body.ok).toBe(true)
    expect(w.body.prefs.seekStep).toBe(30)
    expect(w.body.prefs.evil).toBeUndefined()
    const r = await get('/dsh-tingbar/prefs')
    expect(r.body.prefs.seekStep).toBe(30)
    // 原有偏好不受影响。
    expect(r.body.prefs.volume).toBe(0.5)
  })

  it('fav 增删', async () => {
    const add = await post('/dsh-tingbar/fav', { album: { id: 123, title: '测试专辑' } })
    expect(add.body.favs.length).toBe(1)
    const dup = await post('/dsh-tingbar/fav', { album: { id: 123, title: '测试专辑' } })
    expect(dup.body.favs.length).toBe(1)
    const del = await post('/dsh-tingbar/fav', { album: { id: 123 }, remove: true })
    expect(del.body.favs.length).toBe(0)
  })

  it('未知路径 404', async () => {
    const { status } = await get('/dsh-tingbar/nope')
    expect(status).toBe(404)
  })

  it('qr create/check 流程', async () => {
    const c = await post('/dsh-tingbar/qr/create', {})
    expect(c.body.qrId).toBe('QRID')
    const ck = await get('/dsh-tingbar/qr/check?qrId=QRID')
    expect(ck.body.status).toBe('waiting')
  })

  it('following / likes / subscriptions / write 未登录返回 401 + needLogin', async () => {
    const f = await get('/dsh-tingbar/following')
    expect(f.status).toBe(401)
    expect(f.body.ok).toBe(false)
    expect(f.body.needLogin).toBe(true)
    const l = await get('/dsh-tingbar/likes')
    expect(l.status).toBe(401)
    expect(l.body.needLogin).toBe(true)
    const sub = await get('/dsh-tingbar/subscriptions')
    expect(sub.status).toBe(401)
    expect(sub.body.needLogin).toBe(true)
    const w = await post('/dsh-tingbar/write', { op: 'sub', id: 123, on: true })
    expect(w.status).toBe(401)
    expect(w.body.ok).toBe(false)
    expect(w.body.needLogin).toBe(true)
  })

  it('扫码登录后 following / likes / anchor 可用', async () => {
    // 模拟扫码成功 → cookie + user（uid 42）落盘。
    qrCheck.mockResolvedValueOnce({
      status: 'success',
      cookies: { '1&_token': 'tok', uid: '42' },
      token: 'tok',
    })
    getCurrentUser.mockResolvedValueOnce({ uid: 42, nickname: '测试用户', isVip: false, vipExpireTime: 0, isLoginBan: false })
    const c = await post('/dsh-tingbar/qr/create', {})
    const ck = await get('/dsh-tingbar/qr/check?qrId=' + encodeURIComponent(c.body.qrId))
    expect(ck.body.status).toBe('success')
    expect(ck.body.user.nickname).toBe('测试用户')

    // 已关注的主播（默认取当前用户 uid）。
    const f = await get('/dsh-tingbar/following')
    expect(f.status).toBe(200)
    expect(f.body.ok).toBe(true)
    expect(f.body.uid).toBe(42)
    expect(f.body.anchors.length).toBe(2)
    expect(f.body.anchors[0].nickname).toBe('三体宇宙')
    expect(f.body.total).toBe(2)

    // 收藏的声音。
    const l = await get('/dsh-tingbar/likes?pageNum=1&pageSize=30')
    expect(l.status).toBe(200)
    expect(l.body.ok).toBe(true)
    expect(l.body.tracks.length).toBe(2)
    expect(l.body.tracks[0].title).toBe('收藏的第一集')
    expect(l.body.hasMore).toBe(true)

    // 订阅的专辑。
    const sub = await get('/dsh-tingbar/subscriptions?page=1&pageSize=30')
    expect(sub.status).toBe(200)
    expect(sub.body.ok).toBe(true)
    expect(sub.body.albums.length).toBe(1)
    expect(sub.body.albums[0].title).toBe('订阅的测试专辑')
    expect(sub.body.albums[0].lastTrackTitle).toBe('最新一集')
    expect(sub.body.hasMore).toBe(false)

    // 主页专辑（匿名可用，显式 uid）。
    const a = await get('/dsh-tingbar/anchor?uid=170217760')
    expect(a.status).toBe(200)
    expect(a.body.ok).toBe(true)
    expect(a.body.albums.length).toBe(2)
    expect(a.body.albums[1].isPaid).toBe(true)

    // 云端写操作（登录后可用）。
    const subOn = await post('/dsh-tingbar/write', { op: 'sub', id: 323366, on: true })
    expect(subOn.status).toBe(200)
    expect(subOn.body.ok).toBe(true)
    expect(subOn.body.on).toBe(true)
    expect(subOn.body.msg).toContain('订阅')
    const subOff = await post('/dsh-tingbar/write', { op: 'sub', id: 323366, on: false })
    expect(subOff.body.on).toBe(false)
    const likeOff = await post('/dsh-tingbar/write', { op: 'like', id: 1001, on: false })
    expect(likeOff.body.ok).toBe(true)
    const followOff = await post('/dsh-tingbar/write', { op: 'follow', id: 170217760, on: false })
    expect(followOff.body.ok).toBe(true)
    // on 缺省为 true。
    const likeOn = await post('/dsh-tingbar/write', { op: 'like', id: 1001 })
    expect(likeOn.body.on).toBe(true)
  })

  it('anchor 无效 uid 400', async () => {
    const { status, body } = await get('/dsh-tingbar/anchor?uid=abc')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('write 参数校验：未知 op / 无效 id → 400', async () => {
    const badOp = await post('/dsh-tingbar/write', { op: 'evil', id: 123 })
    expect(badOp.status).toBe(400)
    const badId = await post('/dsh-tingbar/write', { op: 'sub', id: 'abc' })
    expect(badId.status).toBe(400)
  })
})

describe('ximalaya_play tool', () => {
  it('注册了工具与 systemPrompt', () => {
    expect(registeredTool.name).toBe('ximalaya_play')
    expect(promptSection.name).toBe('tool:ximalaya')
    expect(promptSection.text).toContain('ximalaya_play')
  })

  it('query 搜索 → 生成 play 意图', async () => {
    const r = await registeredTool.execute({ query: '测试' })
    expect(r.played).toBe(true)
    expect(r.album).toBe('测试专辑')
    const intent = await get('/dsh-tingbar/intent')
    expect(intent.body.intent.action).toBe('play')
    expect(intent.body.intent.trackId).toBe(1001)
    expect(intent.body.intent.albumId).toBe(123)
  })

  it('意图取走即焚', async () => {
    const intent = await get('/dsh-tingbar/intent')
    expect(intent.body.intent).toBeNull()
  })

  it('albumId 直播', async () => {
    const r = await registeredTool.execute({ albumId: 123 })
    expect(r.played).toBe(true)
    expect(r.track).toBe('第一集')
  })

  it('trackId 直播', async () => {
    const r = await registeredTool.execute({ trackId: 1002 })
    expect(r.played).toBe(true)
    expect(r.track).toContain('1002')
  })

  it('pause 等动作投递意图', async () => {
    const r = await registeredTool.execute({ action: 'pause' })
    expect(r.played).toBe(false)
    expect(r.notice).toContain('暂停')
    const intent = await get('/dsh-tingbar/intent')
    expect(intent.body.intent.action).toBe('pause')
  })

  it('空参数提示', async () => {
    const r = await registeredTool.execute({})
    expect(r.played).toBe(false)
    expect(r.notice).toContain('query')
  })

  it('output.render 输出文字', () => {
    const text = registeredTool.output.render({}, { notice: 'hello' })
    expect(text[0].text).toBe('hello')
  })
})

describe('多平台：?platform= 选择与能力差异', () => {
  it('manifest 暴露平台列表与两个账号槽', async () => {
    const { status, body } = await get('/dsh-tingbar/manifest')
    expect(status).toBe(200)
    expect(body.platform).toBe('ximalaya')
    expect(body.platforms.map((p) => p.id)).toEqual(['ximalaya', 'lrts'])
    expect(body.accounts.map((a) => a.id)).toEqual(['ximalaya', 'lrts'])
    // 前面的用例已经把 ximalaya 登录过了，这里只校验字段形状。
    expect(body.accounts.every((a) => typeof a.loggedIn === 'boolean')).toBe(true)
    expect(body.accounts.every((a) => typeof a.nickname === 'string')).toBe(true)
  })

  it('?platform=lrts 切到懒人听书视图', async () => {
    const { status, body } = await get('/dsh-tingbar/manifest?platform=lrts')
    expect(status).toBe(200)
    expect(body.platform).toBe('lrts')
    expect(body.platformLabel).toBe('懒人听书')
  })

  it('未知平台 400 并提示可用平台', async () => {
    const { status, body } = await get('/dsh-tingbar/manifest?platform=qqmusic')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('ximalaya')
    expect(body.error).toContain('lrts')
  })

  it('懒人听书不支持关注/收藏/订阅/写操作 → 501 unsupported', async () => {
    for (const path of ['/dsh-tingbar/following?platform=lrts', '/dsh-tingbar/likes?platform=lrts', '/dsh-tingbar/subscriptions?platform=lrts']) {
      const { status, body } = await get(path)
      expect(status, path).toBe(501)
      expect(body.ok).toBe(false)
      expect(body.unsupported).toBe(true)
      expect(body.error).toContain('懒人听书')
    }
    const w = await post('/dsh-tingbar/write?platform=lrts', { op: 'like', id: 1, on: true })
    expect(w.status).toBe(501)
    expect(w.body.unsupported).toBe(true)
  })

  it('喜马拉雅没有首页推荐接口 → 501 unsupported', async () => {
    const { status, body } = await get('/dsh-tingbar/home?platform=ximalaya')
    expect(status).toBe(501)
    expect(body.unsupported).toBe(true)
    expect(body.error).toContain('喜马拉雅')
  })

  it('平台偏好持久化：写入后 manifest 默认平台跟着变', async () => {
    const w = await post('/dsh-tingbar/prefs', { prefs: { platform: 'lrts' } })
    expect(w.status).toBe(200)
    expect(w.body.ok).toBe(true)
    const m = await get('/dsh-tingbar/manifest')
    expect(m.body.platform).toBe('lrts')
    // 非法平台值被白名单丢弃，不会污染状态。
    const bad = await post('/dsh-tingbar/prefs', { prefs: { platform: 'qqmusic' } })
    expect(bad.body.platform).toBe('lrts')
    // 收尾：恢复默认平台，避免影响其他用例。
    await post('/dsh-tingbar/prefs', { prefs: { platform: 'ximalaya' } })
  })

  it('收藏按平台分槽：喜马拉雅收藏不影响懒人听书', async () => {
    const album = { id: 555, title: '跨平台测试专辑', cover: '', anchorName: '', trackCount: 1 }
    await post('/dsh-tingbar/fav', { album, remove: false })
    const x = await get('/dsh-tingbar/manifest?platform=ximalaya')
    const l = await get('/dsh-tingbar/manifest?platform=lrts')
    expect(x.body.favs.some((f) => f.id === 555)).toBe(true)
    expect(l.body.favs.some((f) => f.id === 555)).toBe(false)
    expect(l.body.favs.length).toBe(0)
  })

  it('播放快照按平台分槽 + section 透传（懒人听书断点续听）', async () => {
    await post('/dsh-tingbar/prefs?platform=ximalaya', {
      playback: { albumId: 123, trackId: 1001, trackTitle: '第一集', position: 10, duration: 60 },
    })
    const l = await post('/dsh-tingbar/prefs?platform=lrts', {
      playback: { albumId: 84, trackId: 8400000001, trackTitle: '第001集', section: 1, position: 33, duration: 1423 },
    })
    expect(l.body.playback.section).toBe(1)
    const back = await get('/dsh-tingbar/prefs?platform=lrts')
    expect(back.body.playback).toMatchObject({ trackId: 8400000001, section: 1, position: 33 })
    const x = await get('/dsh-tingbar/prefs?platform=ximalaya')
    expect(x.body.playback.trackId).toBe(1001)
    expect(x.body.playback.section).toBeUndefined()
  })

  it('工具支持 platform 参数：懒人听书未登录时给出可读提示', async () => {
    const r = await registeredTool.execute({ query: '史上第一混乱', platform: 'lrts' })
    expect(r.played).toBe(false)
    expect(r.platform).toBe('lrts')
    expect(r.notice).toMatch(/懒人听书/)
  })
})

describe('云端收听历史（/listened：喜马拉雅「听过」、懒人听书「收听记录」）', () => {
  it('未登录 → 401 needLogin（懒人听书一直没登录过）', async () => {
    const r = await get('/dsh-tingbar/listened?platform=lrts')
    expect(r.status).toBe(401)
    expect(r.body.ok).toBe(false)
    expect(r.body.needLogin).toBe(true)
    expect(r.body.message).toMatch(/懒人听书/)
  })

  it('登录后返回账号里的「听过」，并把 pageNum 透传给上游', async () => {
    const r = await get('/dsh-tingbar/listened?platform=ximalaya&pageNum=1&pageSize=2')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.items.length).toBe(2)
    expect(r.body.items[0]).toMatchObject({ trackId: 1017788628, trackTitle: '听过第一集', updatedText: '2天前' })
    expect(r.body.totalCount).toBe(283)
    // provider 的翻页尽头判定必须透传：喜马拉雅上游不翻页 → 恒 false，
    // 客户端据此不再显示无效的「加载更多」。
    expect(r.body.hasMore).toBe(false)
    const args = listenedTracks.mock.calls[listenedTracks.mock.calls.length - 1]
    expect(args[0]).toBe(1)
  })

  it('翻页：pageNum=3 → 上游 pageNum=3', async () => {
    const r = await get('/dsh-tingbar/listened?platform=ximalaya&pageNum=3')
    expect(r.status).toBe(200)
    expect(r.body.pageNum).toBe(3)
    const args = listenedTracks.mock.calls[listenedTracks.mock.calls.length - 1]
    expect(args[0]).toBe(3)
  })

  it('pageSize 被夹在 1..100（防止一次拉爆）', async () => {
    const r = await get('/dsh-tingbar/listened?platform=ximalaya&pageSize=9999')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  it('历史不再有本地存储：/recent 路由已下线 → 404', async () => {
    const r = await get('/dsh-tingbar/recent?platform=ximalaya')
    expect(r.status).toBe(404)
  })
})

describe('云端收藏能力差异', () => {
  it('喜马拉雅没有云端收藏接口 → 501 unsupported', async () => {
    const r = await get('/dsh-tingbar/cloud/favs?platform=ximalaya')
    expect(r.status).toBe(501)
    expect(r.body.unsupported).toBe(true)
  })

  it('懒人听书未登录 → 401 needLogin（不去打上游）', async () => {
    const r = await get('/dsh-tingbar/cloud/favs?platform=lrts')
    expect(r.status).toBe(401)
    expect(r.body.needLogin).toBe(true)
  })

  it('未知平台 → 400', async () => {
    const r = await get('/dsh-tingbar/cloud/favs?platform=qqmusic')
    expect(r.status).toBe(400)
  })
})

describe('会员状态（VIP）归一化到 accounts', () => {
  it('/user 与 manifest.accounts 都带 isVip/vipLevel/vipDays', async () => {
    getCurrentUser.mockResolvedValueOnce({
      uid: 42, nickname: 'VIP用户', isVip: true, vipLevel: 5, vipDays: 159, vipUntil: 0, isLoginBan: false,
    })
    const me = await get('/dsh-tingbar/user')
    expect(me.status).toBe(200)
    expect(me.body.user).toMatchObject({ isVip: true, vipLevel: 5, vipDays: 159 })

    const m = await get('/dsh-tingbar/manifest')
    const acc = m.body.accounts.find((a) => a.id === 'ximalaya')
    expect(acc).toMatchObject({ loggedIn: true, isVip: true, vipLevel: 5, vipDays: 159 })
  })

  it('未登录的平台会员字段是 false / 0（面板好判断「普通账号」）', async () => {
    const m = await get('/dsh-tingbar/manifest')
    const acc = m.body.accounts.find((a) => a.id === 'lrts')
    expect(acc.loggedIn).toBe(false)
    expect(acc.isVip).toBe(false)
    expect(acc.vipDays).toBe(0)
    expect(acc.vipLevel).toBe(0)
  })
})

describe('上一集/下一集（/neighbor：Host 在完整目录里定位相邻章节）', () => {
  it('下一集返回相邻曲目', async () => {
    const r = await get('/dsh-tingbar/neighbor?platform=ximalaya&albumId=123&trackId=1001&dir=1')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.track).toMatchObject({ id: 1002, title: '第二集' })
    expect(r.body.dir).toBe(1)
  })

  it('上一集在边界上返回 track=null（UI 据此提示「已经是第一集」）', async () => {
    const r = await get('/dsh-tingbar/neighbor?platform=ximalaya&albumId=123&trackId=1001&dir=-1')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.track).toBeNull()
  })

  it('缺少 albumId → 400；未知平台 → 400', async () => {
    const bad = await get('/dsh-tingbar/neighbor?platform=ximalaya&trackId=1001')
    expect(bad.status).toBe(400)
    const ghost = await get('/dsh-tingbar/neighbor?platform=qqmusic&albumId=123&trackId=1001')
    expect(ghost.status).toBe(400)
  })
})

describe('发现页：热搜词 / 排行榜（喜马拉雅匿名接口）', () => {
  it('/hots 返回归一化的热搜词数组', async () => {
    const r = await get('/dsh-tingbar/hots?platform=ximalaya')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(Array.isArray(r.body.hots)).toBe(true)
    expect(r.body.hots.length).toBeGreaterThan(0)
    expect(typeof r.body.hots[0]).toBe('string')
  })

  it('/ranks 返回多张榜单（经典免费榜等），专辑字段归一化', async () => {
    const r = await get('/dsh-tingbar/ranks?platform=ximalaya')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(Array.isArray(r.body.boards)).toBe(true)
    expect(r.body.boards.length).toBeGreaterThan(0)
    const b = r.body.boards[0]
    expect(typeof b.rankId).toBe('number')
    expect(typeof b.title).toBe('string')
    expect(Array.isArray(b.albums)).toBe(true)
    expect(b.albums[0]).toMatchObject({ id: 30140766, title: '辽沈晚报', anchorName: '辽沈晚报' })
  })

  it('懒人听书没有热搜/榜单接口 → 501 unsupported', async () => {
    const h = await get('/dsh-tingbar/hots?platform=lrts')
    expect(h.status).toBe(501)
    expect(h.body.unsupported).toBe(true)
    expect(h.body.error).toContain('懒人听书')
    const r = await get('/dsh-tingbar/ranks?platform=lrts')
    expect(r.status).toBe(501)
    expect(r.body.unsupported).toBe(true)
  })
})

describe('分类榜单：下拉数据源 / 榜单内容', () => {
  it('/rank/cats 返回一级分类树（含「小说」及其子榜单）', async () => {
    const r = await get('/dsh-tingbar/rank/cats?platform=ximalaya')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(Array.isArray(r.body.tabs)).toBe(true)
    const novel = r.body.tabs.find((t) => t.name === '小说')
    expect(novel).toBeTruthy()
    expect(novel.wraps.map((w) => w.name)).toEqual(expect.arrayContaining(['热播', '玄幻']))
    expect(novel.wraps[0]).toHaveProperty('rankingId', 100168)
  })

  it('/rank/content 返回单个榜单内容（专辑归一化 + 名次）', async () => {
    const r = await get('/dsh-tingbar/rank/content?platform=ximalaya&cat=100168')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.title).toBe('小说 · 热播榜')
    expect(Array.isArray(r.body.albums)).toBe(true)
    expect(r.body.albums[0]).toMatchObject({ id: 40121646, title: '三体（全集）', anchorName: '三体宇宙', isPaid: true })
  })

  it('/rank/content 不传 pageNum 时不再默认 10（上游应返回完整榜单 Top100）', async () => {
    rankElement.mockClear()
    await get('/dsh-tingbar/rank/content?platform=ximalaya&cat=100168')
    expect(rankElement).toHaveBeenCalledWith(100168, undefined)
  })

  it('/rank/content 缺 cat → 400', async () => {
    const r = await get('/dsh-tingbar/rank/content?platform=ximalaya')
    expect(r.status).toBe(400)
  })

  it('懒人听书 /rank/cats 返回分组榜单树', async () => {
    const r = await get('/dsh-tingbar/rank/cats?platform=lrts')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.tabs.length).toBe(2)
    expect(r.body.tabs[0]).toMatchObject({ name: '全部' })
    expect(r.body.tabs[0].wraps.map((w) => w.name)).toEqual(['热播榜', '畅销榜'])
  })

  it('懒人听书 /rank/content 返回榜单内容（专辑归一化）', async () => {
    const r = await get('/dsh-tingbar/rank/content?platform=lrts&cat=75')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.title).toBe('热播榜')
    expect(r.body.albums[0]).toMatchObject({ id: 84, title: '史上第一混乱', playCount: 231119442 })
  })
})
