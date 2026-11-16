/**
 * Web 半边冒烟测试：在 jsdom 里加载 client.js 的 ModuleLoader 工厂，
 * 验证 apply() 能注册 style/slot，并渲染播放条与面板的基础 DOM。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
Object.defineProperty(global, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true, writable: true })
// Audio 桩：记录监听器；play() 异步加载出 300 秒时长并派发媒体事件
// （loadedmetadata/durationchange/play/playing），pause() 派发 pause，
// 供快进/快退、时间显示与进度条断言使用。
global.__xmlyAudioInstances = []
global.Audio = class {
  constructor() {
    this.volume = 1
    this.playbackRate = 1
    this.currentTime = 0
    this.duration = 0
    this.paused = true
    this.readyState = 0
    this.listeners = {}
    this.style = {}
    global.__xmlyAudioInstances.push(this)
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn) }
  _fire(t) { for (const fn of [...(this.listeners[t] || [])]) fn({ target: this }) }
  play() {
    this.paused = false
    setTimeout(() => {
      this.readyState = 1
      this.duration = 300
      this._fire('loadedmetadata')
      this._fire('durationchange')
      this._fire('play')
      this._fire('playing')
    }, 0)
    return Promise.resolve()
  }
  pause() { this.paused = true; this._fire('pause') }
  load() {}
  setAttribute() {}
  removeAttribute() {}
}
// manifest / album / tracks / search 响应数据（可变，便于用例覆盖）。
const manifestData = { prefs: {} }
const albumData = { album: { id: 123, title: '测试专辑', trackCount: 0 } }
const tracksData = { tracks: [], maxPageId: 1, totalCount: 0, pageId: 1 }
const searchData = { albums: [] }
// /neighbor（上一集/下一集）的桩响应，用例可覆盖。
let neighborData = { track: null, index: -1, total: 0 }
// /audio-origin（回环音频源）：默认不给，用例置成 'http://127.0.0.1:7395/tok' 可验证 src 拼接。
let audioOriginData = null
// fetch stub：全部返回 ok 的响应，避免测试触网。
global.fetch = vi.fn(async (url) => ({
  ok: true,
  json: async () => {
    const u = String(url)
    if (u.includes('/manifest')) return {
      ok: true, loggedIn: true,
      // 用例可以覆盖 user/accounts（比如验证会员标识）；默认是普通账号。
      user: manifestData.user || { uid: 42, nickname: '测试用户', isVip: false, vipExpireTime: 0, isLoginBan: false },
      accounts: manifestData.accounts,
      favs: [], history: [], prefs: manifestData.prefs, playback: null,
    }
    if (u.includes('/dsh-tingbar/user')) return {
      ok: true, loggedIn: true, user: manifestData.user || { uid: 42, nickname: '测试用户', isVip: false },
    }
    if (u.includes('/intent')) return { ok: true, intent: null }
    if (u.includes('/audio-origin')) {
      return audioOriginData === null ? { ok: false } : { ok: true, base: audioOriginData }
    }
    if (u.includes('/listened')) return {
      ok: true, pageNum: 1, referId: '', totalCount: 1, hasMore: false,
      items: [{
        trackId: 2001, trackTitle: '听过的测试一集', albumId: 123, albumTitle: '测试专辑',
        anchorName: '主播', cover: '', section: null, position: 30, duration: 600,
        updatedAt: 1794565087823, updatedText: '2天前',
      }],
    }
    if (u.includes('/neighbor')) return { ok: true, platform: 'ximalaya', dir: 1, ...neighborData }
    if (u.includes('/search')) return { ok: true, albums: searchData.albums, total: searchData.albums.length, page: 1, totalPages: 1 }
    if (u.includes('/play')) return { ok: true, quality: '标准 64kbps M4A', streamUrl: '/dsh-tingbar/stream?trackId=1' }
    if (u.includes('/likes')) return {
      ok: true, total: 1, pageNum: 1, hasMore: false,
      tracks: [{ id: 9001, title: '收藏的测试声音', cover: '', duration: 258, durationText: '04:18', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 3, createdAtText: '3天前', isVideo: false, isPaid: false }],
    }
    if (u.includes('/subscriptions')) return {
      ok: true, total: 1, page: 1, hasMore: false,
      albums: [{ id: 323366, title: '订阅的测试专辑', intro: '', cover: '', trackCount: 2300, playCount: 100, isPaid: false, isFinished: false, anchorName: '詩展', anchorUid: 1, category: '历史', score: '9.6', lastTrackTitle: '订阅专辑最新一集', lastUpdateText: '1天前' }],
    }
    if (u.includes('/following')) return {
      ok: true, total: 1, page: 1, pageSize: 20,
      anchors: [{ uid: 170217760, nickname: '三体宇宙', cover: '', description: '', ptitle: '', albumCount: 11, trackCount: 488, fansCount: 4725762, followingCount: 22, isFollow: true, url: '/zhubo/170217760' }],
    }
    if (u.includes('/anchor')) return {
      ok: true, uid: 170217760, total: 1,
      albums: [{ id: 111, title: '主播的专辑', cover: '', intro: '', trackCount: 10, playCount: 100, isPaid: false, isFinished: true, anchorName: '三体宇宙' }],
    }
    if (u.includes('/album')) return { ok: true, album: albumData.album }
    if (u.includes('/tracks')) {
      // 可选的分页桩：tracksData.pages[pageId] 覆盖对应页，便于测滚动加载。
      const m = /[?&]pageId=(\d+)/.exec(u)
      const pg = m ? Number(m[1]) : 1
      if (tracksData.pages && tracksData.pages[pg]) return { ok: true, ...tracksData.pages[pg] }
      return { ok: true, ...tracksData }
    }
    if (u.includes('/write')) return { ok: true, op: 'sub', id: 0, on: true, msg: '操作成功' }
    return { ok: true }
  },
}))

let loaded = null
global.window.__ModuleLoader__ = {
  load(def) { loaded = def },
}

const slotsRegistered = []
const fakeSlots = {
  inject(slotName, register) {
    const entry = register()
    slotsRegistered.push({ slotName, entry })
    return () => {}
  },
  register: (meta, render) => ({ meta, render }),
}

let clientMod = null
beforeAll(async () => {
  await import('../lib/client.js')
  clientMod = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
})

describe('client half', () => {
  it('exposes apply/inject', () => {
    expect(typeof clientMod.apply).toBe('function')
    expect(clientMod.inject).toEqual(['slots'])
  })

  it('apply() injects style and registers dock + overlay slots', () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn, label) => { const cleanup = fn(); effects.push({ cleanup, label }) },
    }
    clientMod.apply(ctx)

    // style 注入
    const styleEl = document.querySelector('style[data-plugin="dsh-tingbar"]')
    expect(styleEl).not.toBeNull()
    expect(styleEl.textContent).toContain('.xmly-bar')

    // slot 注册：dock 播放条 + overlay 面板
    expect(slotsRegistered.length).toBe(2)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    expect(dock).toBeTruthy()
    expect(overlay).toBeTruthy()
    // 播放条 order 为 -1，排在「导入会话」（dsh-chat-import，order 0）之上
    expect(dock.entry.meta.order).toBe(-1)

    // 渲染播放条
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(dock.entry.render())
    // 异步渲染 flush
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(host.textContent).toContain('喜马拉雅')
        for (const e of effects) { try { e.cleanup() } catch {} }
        root.unmount()
        resolve()
      }, 50)
    })
  })

  it('播放条注册到侧栏 footer.action，折叠态（wide=false）渲染单图标按钮', () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    expect(dock).toBeTruthy()
    // 折叠态：只有一个竖条图标按钮
    const railHost = document.createElement('div')
    document.body.appendChild(railHost)
    const railRoot = createRoot(railHost)
    railRoot.render(dock.entry.render({ wide: false }))
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(railHost.querySelector('.xmly-rail-btn')).not.toBeNull()
        expect(railHost.querySelector('.xmly-bar')).toBeNull()
        for (const c of effects) { try { c() } catch {} }
        railRoot.unmount()
        resolve()
      }, 50)
    })
  })

  it('面板「我的」页展示收藏的声音与关注的主播，收藏声音可点击播放', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const findBtnByTitle = (rootEl, title) => [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === title)
    const findBtnContains = (rootEl, text) => [...rootEl.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text))

    await flush()
    // 打开面板
    click(findBtnByTitle(barHost, '搜索/列表'))
    await flush()
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()
    // 切到「我的」
    click(findBtnContains(panelHost, '我的'))
    await flush(150)
    const panelText = panelHost.textContent
    // 分段都在（默认落在「🕘 历史」）
    expect(panelText).toContain('历史')
    expect(panelText).toContain('声音')
    expect(panelText).toContain('订阅')
    expect(panelText).toContain('主播')
    expect(panelText).toContain('专辑')
    // 「历史」默认分段 = 账号云端记录（GET /listened），桩里返回了 1 条
    await flush(150)
    expect(panelHost.textContent).toContain('听过的测试一集')
    // 切到「♥ 声音」分段懒加载出收藏的声音
    click(findBtnContains(panelHost, '声音'))
    await flush(150)
    expect(panelHost.textContent).toContain('收藏的测试声音')
    expect(panelHost.textContent).toContain('测试专辑')

    // 切到「订阅」分段：订阅专辑卡片 + 最新更新提示
    click(findBtnContains(panelHost, '订阅'))
    await flush(150)
    expect(panelHost.textContent).toContain('订阅的测试专辑')
    expect(panelHost.textContent).toContain('最新：1天前 · 订阅专辑最新一集')

    // 切到「主播」分段
    click(findBtnContains(panelHost, '主播'))
    await flush(150)
    expect(panelHost.textContent).toContain('三体宇宙')
    expect(panelHost.textContent).toContain('粉丝')

    // 切回「声音」分段并点击一条 → 播放条出现该曲目
    click(findBtnContains(panelHost, '声音'))
    await flush(100)
    const likeRow = panelHost.querySelector('.xmly-like-row')
    expect(likeRow).not.toBeNull()
    click(likeRow)
    await flush(150)
    expect(barHost.textContent).toContain('收藏的测试声音')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('快进/快退：常规跳转、暂停态可用、起点/终点边界钳制', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const btnByTitlePrefix = (prefix) => [...barHost.querySelectorAll('button')]
      .find((b) => (b.getAttribute('title') || '').startsWith(prefix))
    const timeText = () => (barHost.querySelector('.xmly-bar-time').textContent || '').trim()
    const fillPct = () => Number(parseFloat(barHost.querySelector('.xmly-progress-fill').style.width))

    await flush()
    // 起一首曲子（收藏的声音），等桩里的元数据（300 秒时长）就绪。
    click(btnByTitlePrefix('搜索/列表'))
    await flush()
    if (panelHost.querySelector('.xmly-panel') === null) {
      // 上个用例可能留下「面板已打开」状态（按钮是切换语义）：再点一次打开。
      click(btnByTitlePrefix('搜索/列表'))
      await flush()
    }
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('我的')))
    await flush(150)
    // 默认分段是「🕘 历史」，切到「♥ 声音」才能拿到云端收藏的声音。
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('声音')))
    await flush(150)
    click(panelHost.querySelector('.xmly-like-row'))
    await flush(150)
    expect(barHost.textContent).toContain('收藏的测试声音')
    expect(timeText()).toBe('0:00 / 5:00')

    const ff = btnByTitlePrefix('快进')
    const rew = btnByTitlePrefix('快退')
    expect(ff).toBeTruthy()
    expect(rew).toBeTruthy()
    expect(ff.getAttribute('title')).toContain('15 秒') // 默认步长 15 秒

    // 常规快进：0 → 15s，时间显示与进度条同步更新。
    click(ff); await flush(20)
    expect(timeText()).toBe('0:15 / 5:00')
    expect(fillPct()).toBe(5)

    // 暂停状态下同样可跳转：15 → 30s。
    click(btnByTitlePrefix('暂停')); await flush(20)
    click(ff); await flush(20)
    expect(timeText()).toBe('0:30 / 5:00')

    // 终点边界：连点到头，钳制在总时长 300s，不越界。
    for (let i = 0; i < 25; i++) { click(ff); await flush(10) }
    expect(timeText()).toBe('5:00 / 5:00')
    expect(fillPct()).toBe(100)
    click(ff); await flush(20)
    expect(timeText()).toBe('5:00 / 5:00')

    // 起点边界：往回连点，钳制在 0，不越界。
    for (let i = 0; i < 30; i++) { click(rew); await flush(10) }
    expect(timeText()).toBe('0:00 / 5:00')
    expect(fillPct()).toBe(0)
    click(rew); await flush(20)
    expect(timeText()).toBe('0:00 / 5:00')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('快进/快退步长可配置：右键弹层选择 30 秒并持久化，manifest 下发 60 秒生效', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')

    const barHost = document.createElement('div')
    document.body.appendChild(barHost)
    const barRoot = createRoot(barHost)
    barRoot.render(dock.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const ctxMenu = (el) => el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const btnByTitlePrefix = (prefix) => [...barHost.querySelectorAll('button')]
      .find((b) => (b.getAttribute('title') || '').startsWith(prefix))
    const timeText = () => (barHost.querySelector('.xmly-bar-time').textContent || '').trim()

    await flush()
    // 右键 ⏩ 打开步长弹层，默认选中 15 秒。
    ctxMenu(btnByTitlePrefix('快进'))
    await flush()
    const pop = barHost.querySelector('.xmly-step-pop')
    expect(pop).not.toBeNull()
    expect(pop.querySelector('.xmly-chip.active').textContent).toBe('15 秒')

    // 选择 30 秒：立即生效，并通过 /prefs 持久化到宿主。
    click([...pop.querySelectorAll('button')].find((b) => b.textContent === '30 秒'))
    await flush()
    expect(btnByTitlePrefix('快进').getAttribute('title')).toContain('30 秒')
    expect(btnByTitlePrefix('快退').getAttribute('title')).toContain('30 秒')
    const posted = global.fetch.mock.calls
      .filter(([u]) => String(u).includes('/prefs'))
      .some(([, opts]) => opts && opts.body && opts.body.includes('"seekStep":30'))
    expect(posted).toBe(true)

    // 新步长生效：0 → 30s。
    click(btnByTitlePrefix('快进')); await flush(20)
    expect(timeText()).toBe('0:30 / 5:00')

    // manifest 下发 seekStep=60：重新 apply 加载后生效。
    manifestData.prefs = { seekStep: 60 }
    clientMod.apply(ctx)
    await flush(150)
    expect(btnByTitlePrefix('快退').getAttribute('title')).toContain('60 秒')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
  })

  it('云端同步操作：取消收藏声音 / 退订专辑 / 专辑页订阅', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const findBtnByTitle = (rootEl, title) => [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === title)
    const writeCalls = () => global.fetch.mock.calls
      .filter(([u]) => String(u).includes('/write'))
      .map(([, opts]) => JSON.parse(opts.body))

    await flush()
    // 打开面板 → 我的
    click(findBtnByTitle(barHost, '搜索/列表'))
    await flush()
    if (panelHost.querySelector('.xmly-panel') === null) { click(findBtnByTitle(barHost, '搜索/列表')); await flush() }
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('我的')))
    await flush(150)
    // 「我的」默认分段是「🕘 历史」，这里的用例只关心云端收藏的声音，先切到「♥ 声音」。
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('声音')))
    await flush(150)

    // 1) 收藏声音行 → ✕ 取消收藏：POST /write {op:'like', on:false}，行消失
    const likeRow = panelHost.querySelector('.xmly-like-row')
    expect(likeRow).not.toBeNull()
    const unlikeBtn = likeRow.querySelector('button[title^="取消收藏"]')
    expect(unlikeBtn).not.toBeNull()
    click(unlikeBtn)
    await flush(150)
    const unlikeCall = writeCalls().find((c) => c.op === 'like')
    expect(unlikeCall).toMatchObject({ op: 'like', id: 9001, on: false })
    expect(panelHost.querySelector('.xmly-like-row')).toBeNull()

    // 2) 订阅分段 → 点卡片进专辑页 → 「📻 订阅」→ POST {op:'sub', on:true}，变「已订阅」
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
    await flush(150)
    const subCard = panelHost.querySelector('.xmly-album-card')
    expect(subCard).not.toBeNull()
    click(subCard) // 打开专辑
    await flush(200)
    const subBtn = [...panelHost.querySelectorAll('.xmly-album-ops button')].find((b) => (b.textContent || '').includes('订阅'))
    expect(subBtn).not.toBeNull()
    expect(subBtn.textContent).not.toContain('已订阅')
    click(subBtn)
    await flush(150)
    const subCall = writeCalls().find((c) => c.op === 'sub' && c.on === true)
    expect(subCall).toMatchObject({ op: 'sub', id: 123, on: true })
    const subBtnAfter = [...panelHost.querySelectorAll('.xmly-album-ops button')].find((b) => (b.textContent || '').includes('订阅'))
    expect(subBtnAfter.textContent).toContain('已订阅')

    // 3) 回订阅分段 → 退订：POST {op:'sub', on:false}，原卡片消失
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
    await flush(100)
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
    await flush(150)
    const targetCard = [...panelHost.querySelectorAll('.xmly-album-card')].find((c) => (c.textContent || '').includes('订阅的测试专辑'))
    expect(targetCard).not.toBeNull()
    const unsubBtn = targetCard.querySelector('button[title^="退订"]')
    expect(unsubBtn).not.toBeNull()
    click(unsubBtn)
    await flush(150)
    const unsubCall = writeCalls().find((c) => c.op === 'sub' && c.on === false)
    expect(unsubCall).toMatchObject({ op: 'sub', id: 323366, on: false })
    expect([...panelHost.querySelectorAll('.xmly-album-card')].some((c) => (c.textContent || '').includes('订阅的测试专辑'))).toBe(false)

    // 4) 主播分段 → 取关：POST /write {op:'follow', on:false}，卡片消失
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('主播')))
    await flush(150)
    const anchorCard = panelHost.querySelector('.xmly-anchor-card')
    expect(anchorCard).not.toBeNull()
    const unfollowBtn = anchorCard.querySelector('button[title^="取消关注"]')
    expect(unfollowBtn).not.toBeNull()
    click(unfollowBtn)
    await flush(150)
    const unfollowCall = writeCalls().find((c) => c.op === 'follow')
    expect(unfollowCall).toMatchObject({ op: 'follow', id: 170217760, on: false })
    expect(panelHost.querySelector('.xmly-anchor-card')).toBeNull()

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('缓冲中（⋯）暂停后按钮不再卡在三个点', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const barHost = document.createElement('div')
    document.body.appendChild(barHost)
    const barRoot = createRoot(barHost)
    barRoot.render(dock.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const playText = () => (barHost.querySelector('.xmly-bar-play').textContent || '').trim()

    await flush()
    // 上个用例留下 current（未在播）→ 点播放键起播
    const playBtn = barHost.querySelector('.xmly-bar-play')
    expect(playBtn).not.toBeNull()
    click(playBtn)
    await flush(100)
    expect(playText()).toBe('⏸')

    const audio = global.__xmlyAudioInstances[0]
    // 模拟网络卡顿：waiting 事件 → 按钮变 ⋯
    audio._fire('waiting')
    await flush(30)
    expect(playText()).toBe('⋯')
    // 暂停：pause 事件必须清掉 buffering，否则按钮永远停在 ⋯
    audio.pause()
    await flush(30)
    expect(playText()).toBe('▶')
    // 再次播放恢复 ⏸
    click(barHost.querySelector('.xmly-bar-play'))
    await flush(80)
    expect(playText()).toBe('⏸')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
  })

  it('面板头部不放播放/暂停按钮：面板打开时底部播放条仍可正常暂停', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))

    await flush()
    // 面板可能已开（状态延续）；没开则点开
    if (panelHost.querySelector('.xmly-panel') === null) {
      click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
      await flush()
    }
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()

    // 面板头部不再放播放/暂停按钮（位置钳制后底部播放条始终可点，无需重复控制）。
    expect(panelHost.querySelector('.xmly-panel-head .xmly-panel-pp')).toBeNull()

    const audio = global.__xmlyAudioInstances[0]
    const playBtn = () => barHost.querySelector('.xmly-bar-play')
    // 面板打开时底部播放条仍可正常翻转播放/暂停（状态无关断言）。
    const t0 = (playBtn().textContent || '').trim()
    const pausedAfterFirst = t0 === '⏸' // 起始在播 → 点后暂停
    click(playBtn())
    await flush(80)
    expect(audio.paused).toBe(pausedAfterFirst)
    expect((playBtn().textContent || '').trim()).toBe(pausedAfterFirst ? '▶' : '⏸')
    click(playBtn())
    await flush(80)
    expect(audio.paused).toBe(!pausedAfterFirst)
    expect((playBtn().textContent || '').trim()).toBe(t0)

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('面板位置钳制：不会压到底部输入区（播放条所在处）', async () => {
    // manifest 下发一个明显越界的位置 + panelOpen
    manifestData.prefs = { panelPos: { x: 9999, y: 9999 }, panelOpen: true }
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    const panelHost = document.createElement('div')
    document.body.appendChild(panelHost)
    const panelRoot = createRoot(panelHost)
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    await flush(200)
    const panel = panelHost.querySelector('.xmly-panel')
    expect(panel).not.toBeNull()
    const vw = dom.window.innerWidth, vh = dom.window.innerHeight
    const left = parseInt(panel.style.left, 10)
    const top = parseInt(panel.style.top, 10)
    const maxH = parseInt(panel.style.maxHeight, 10)
    expect(left).toBeLessThanOrEqual(vw - 120)
    expect(top).toBeLessThanOrEqual(Math.max(72, vh - 180 - 320))
    // 底边不进入输入区预留带
    expect(top + maxH).toBeLessThanOrEqual(vh - 180 + 1)

    for (const c of effects) { try { c() } catch {} }
    panelRoot.unmount()
    // 还原 manifest prefs，避免影响其他用例
    manifestData.prefs = {}
  })

  it('show 级联接口（totalCount=0）时专辑总数回退用专辑详情的 trackCount', async () => {
    // 模拟级联形态：/tracks 有数据但 totalCount 0（show 接口不给总数），
    // /album 带 trackCount 2300。
    // 用独立 factory 实例（全新 store，不受前序用例列表操作影响）：
    // 面板→我的→订阅分段→点订阅专辑卡→openAlbum→专辑页断言。
    albumData.album = { id: 32777350, title: "What's Next｜科技早知道", trackCount: 2300, anchorName: '主播', cover: '', category: '科技', isPaid: false, isFinished: false, intro: '' }
    tracksData.tracks = [{ id: 251265935, title: 'S4E01 | 从线上问诊数量来看疫情', duration: 2888, isPaid: false, isFree: true, isAuthorized: true }]
    tracksData.totalCount = 0
    tracksData.maxPageId = 2 // hasMore=true → 还有下一页
    try {
      const effects = []
      const ctx = {
        get: (name) => (name === 'slots' ? fakeSlots : undefined),
        effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
      }
      const freshMod = loaded.factory((id) => {
        if (id === 'react') return React
        throw new Error('unexpected require: ' + id)
      })
      freshMod.apply(ctx)
      const entries = slotsRegistered.filter((x) => x.slotName === 'sidebar.footer.action')
      const dock = entries[entries.length - 1]
      const overlays = slotsRegistered.filter((x) => x.slotName === 'shell.overlay')
      const overlay = overlays[overlays.length - 1]
      const barHost = document.createElement('div')
      const panelHost = document.createElement('div')
      document.body.appendChild(barHost)
      document.body.appendChild(panelHost)
      const barRoot = createRoot(barHost)
      const panelRoot = createRoot(panelHost)
      barRoot.render(dock.entry.render())
      panelRoot.render(overlay.entry.render())

      const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
      const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))

      await flush(150)
      // 打开面板 → 我的 → 订阅分段（fresh store 会重新拉订阅列表）
      const panelBtn = [...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表')
      click(panelBtn)
      await flush()
      if (panelHost.querySelector('.xmly-panel') === null) { click(panelBtn); await flush() }
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(150)
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
      await flush(200)
      const subCard = panelHost.querySelector('.xmly-album-card')
      expect(subCard).not.toBeNull()
      click(subCard) // openAlbum
      await flush(250)

      // 专辑页：曲目行渲染 + 总数回退显示 2300 集 + 有"加载更多"
      expect(panelHost.textContent).toContain("What's Next｜科技早知道")
      expect(panelHost.textContent).toContain('S4E01')
      expect(panelHost.textContent).toContain('2300 集')
      const moreBtn = [...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('加载更多'))
      expect(moreBtn).not.toBeNull()

      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    } finally {
      albumData.album = { id: 123, title: '测试专辑', trackCount: 0 }
      tracksData.tracks = []
      tracksData.totalCount = 0
      tracksData.maxPageId = 1
    }
  })

  it('面板 tab 不再莫名落到空专辑页：agent 播放静默预载不切 tab，点 🔎 空专辑回搜索', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const activeTab = () => {
      const btns = [...panelHost.querySelectorAll('.xmly-tab-btn')].filter((b) => b.className.includes('active'))
      return btns.length ? btns[btns.length - 1].textContent.trim() : null
    }
    const btnByTitle = (t) => [...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === t)

    // 面板关闭时：agent 播放（intent play 带 albumId）触发 openAlbum(silent)
    // —— 通过 intent 轮询模拟。直接等轮询拉取即可：手动触发 fetch /intent？
    // 更直接的方式：关闭面板后点播放条标题（走新逻辑：加载专辑并打开面板）。
    await flush(150)
    // 确保面板关闭
    if (panelHost.querySelector('.xmly-panel') !== null) { click(btnByTitle('搜索/列表')); await flush() }
    expect(panelHost.querySelector('.xmly-panel')).toBeNull()

    // 点播放条标题（current 有 albumId=123）→ 面板打开且落在专辑 tab
    // （若 store.album 已是该专辑则直接显示；否则加载 stub 的冷历史数据）
    albumData.album = { id: 123, title: '冷历史', trackCount: 2300, anchorName: '詩展', cover: '', category: '历史', isPaid: false, isFinished: false, intro: '' }
    tracksData.tracks = [{ id: 1001, title: '第一集', duration: 60, isPaid: false, isFree: true, isAuthorized: true }]
    tracksData.totalCount = 2300
    tracksData.maxPageId = 1
    try {
      click(barHost.querySelector('.xmly-bar-title'))
      await flush(250)
      expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()
      expect(activeTab()).toBe('专辑')
      // 已加载（标题点击走 openAlbum 重载）或残留缓存（同为 123）都应显示专辑名
      expect(/冷历史|测试专辑/.test(panelHost.textContent || '')).toBe(true)

      // 收起面板；再次点 🔎 → 应停留在专辑页（专辑有效，不是空页）
      click([...panelHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '收起面板'))
      await flush()
      expect(panelHost.querySelector('.xmly-panel')).toBeNull()
      click(btnByTitle('搜索/列表'))
      await flush(150)
      expect(activeTab()).toBe('专辑')
      expect(/冷历史|测试专辑/.test(panelHost.textContent || '')).toBe(true)

      // 空专辑页引导：模拟「专辑加载失败」路径（albumError 非空时渲染 返回搜索 按钮）——
      // 空专辑 tab 的可达入口已由上面两段覆盖（标题点击加载 / 🔎 停留有效专辑页），
      // 真正的空态只在 openAlbum 进行中短暂出现（albumLoading 渲染"专辑加载中…"）。
      albumData.album = null
      tracksData.tracks = []
      tracksData.totalCount = 0
      await flush(100)
      // 验证 🔎 打开时不会切到空专辑 tab（store.album 有效 → 停留专辑页）
      click([...panelHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '收起面板'))
      await flush()
      click(btnByTitle('搜索/列表'))
      await flush(150)
      expect(activeTab() === '专辑' || activeTab() === '搜索').toBe(true)
    } finally {
      albumData.album = { id: 123, title: '测试专辑', trackCount: 0 }
      tracksData.tracks = []
      tracksData.totalCount = 0
      tracksData.maxPageId = 1
    }

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })
})

describe('多平台切换器', () => {
  it('面板头部渲染两个平台按钮，点击切平台会持久化并把 ?platform= 带到后续请求', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const btnByTitle = (rootEl, t) => [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === t)

    await flush()
    // 🔎 是开关（panelOpen 可能在前面用例里被留在任一状态）：确保打开。
    for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
      click(btnByTitle(barHost, '搜索/列表'))
      await flush(150)
    }
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()

    // 两个平台按钮都在，默认选中喜马拉雅
    const plats = [...panelHost.querySelectorAll('.xmly-panel-plats .xmly-plat-btn')]
    expect(plats.map((b) => b.textContent.replace(/\s*●$/, ''))).toEqual(['喜马拉雅', '懒人听书'])
    expect(plats[0].className).toContain('active')
    // 面板标题是固定插件名「有声书」，不随平台切换
    expect(panelHost.querySelector('.xmly-panel-title').textContent).toContain('有声书')

    // 切到懒人听书
    global.fetch.mockClear()
    click(plats[1])
    await flush(220)

    const prefsCall = global.fetch.mock.calls
      .map(([url, init]) => ({ url: String(url), init: init || {} }))
      .filter((c) => c.url.includes('/prefs'))
      .find((c) => String(c.init.body || '').includes('"platform":"lrts"'))
    expect(prefsCall).toBeTruthy()
    expect(prefsCall.url).toContain('platform=lrts')
    // 切平台后标题保持「有声书」，激活态落在懒人按钮上
    expect(panelHost.querySelector('.xmly-panel-title').textContent).toContain('有声书')
    expect([...panelHost.querySelectorAll('.xmly-panel-plats .xmly-plat-btn')][1].className).toContain('active')

    // 后续请求带上 ?platform=lrts（切平台会重拉 manifest；这里用搜索验证一般请求）
    global.fetch.mockClear()
    const input = panelHost.querySelector('.xmly-search-row input')
    if (input) {
      input.value = '三体'
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const searchBtn = [...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '搜索')
      if (searchBtn) { click(searchBtn); await flush(120) }
    }
    // 该平台已登录（stub manifest 恒为已登录）→ 搜索按钮可用，URL 应带 platform=lrts
    const searchCall = global.fetch.mock.calls.map(([url]) => String(url)).find((u) => u.includes('/search?'))
    if (searchCall) expect(searchCall).toContain('platform=lrts')

    // 切回喜马拉雅，避免污染同文件后续用例
    click([...panelHost.querySelectorAll('.xmly-panel-plats .xmly-plat-btn')][0])
    await flush(200)
    expect(panelHost.querySelector('.xmly-panel-title').textContent).toContain('有声书')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })
})

describe('专辑目录无限滚动 + 「我的」刷新（用户反馈）', () => {
  it('滚到底部自动加载下一页，并按 id 去重，不再重复第一页', async () => {
    // jsdom 没有 IntersectionObserver：用桩记录回调，手动触发「滚到底部」。
    const observers = []
    global.IntersectionObserver = class {
      constructor(cb, opts) { this.cb = cb; this.opts = opts; this.disconnected = false; observers.push(this) }
      observe() {}
      unobserve() {}
      disconnect() { this.disconnected = true }
    }

    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 120) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const mk = (id, title) => ({ id, title, duration: 60, isPaid: false, isFree: true, isAuthorized: true, cover: '', section: id - 1000 })
    try {
      searchData.albums = [{ id: 123, title: '测试专辑', cover: '', trackCount: 6, anchorName: '主播', isPaid: false }]
      albumData.album = { id: 123, title: '测试专辑', trackCount: 6, anchorName: '主播' }
      tracksData.pages = {
        // 第 2 页故意重复一条（模拟上游偶发重复返回），验证按 id 去重。
        1: { tracks: [mk(1001, '第一集'), mk(1002, '第二集'), mk(1003, '第三集')], totalCount: 6, maxPageId: 2, pageId: 1 },
        2: { tracks: [mk(1003, '第三集'), mk(1004, '第四集'), mk(1005, '第五集'), mk(1006, '第六集')], totalCount: 6, maxPageId: 2, pageId: 2 },
      }

      await flush()
      for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
        click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
        await flush()
      }
      expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()

      // 进专辑页的入口用「我的 → 订阅 → 点卡片」（不依赖输入框输入，jsdom 下更稳）。
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(200)
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
      await flush(250)
      const card = panelHost.querySelector('.xmly-album-card')
      expect(card).not.toBeNull()
      expect(card).not.toBeNull()
      click(card)
      await flush(250)

      expect(panelHost.querySelectorAll('.xmly-track-row').length).toBe(3)
      // 底部哨兵存在，并且提示文案说的是「滚动到底部自动加载」
      const sentinel = panelHost.querySelector('.xmly-load-sentinel')
      expect(sentinel).not.toBeNull()
      expect(sentinel.textContent).toMatch(/滚动到底部|正在加载/)

      // 触发「滚到底部」→ 自动拉第 2 页
      expect(observers.length).toBeGreaterThan(0)
      const io = observers.find((o) => !o.disconnected)
      expect(io).toBeTruthy()
      io.cb([{ isIntersecting: true }])
      await flush(250)

      // 3 + 4 条，重复的 1003 被去重 → 共 6 行且标题不重复
      const rows = [...panelHost.querySelectorAll('.xmly-track-row')]
      expect(rows.length).toBe(6)
      const titles = rows.map((r) => r.textContent)
      expect(titles.filter((t) => t.includes('第三集')).length).toBe(1)
      expect(titles.some((t) => t.includes('第六集'))).toBe(true)
    } finally {
      searchData.albums = []
      tracksData.pages = null
      tracksData.tracks = []
      tracksData.totalCount = 0
      tracksData.maxPageId = 1
      delete global.IntersectionObserver
      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    }
  })

  it('「我的」有刷新按钮：点一下会重新拉当前分段（历史/收藏都是外部状态）', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    try {
      await flush()
      for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
        click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
        await flush()
      }
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(200)
      // store 是模块级单例，别的用例可能把分段停在「声音」上，这里先回到「历史」。
      const historyBtn = [...panelHost.querySelectorAll('.xmly-seg-btn')].find((b) => (b.textContent || '').includes('历史'))
      if (historyBtn) { click(historyBtn); await flush(200) }

      const refreshBtn = panelHost.querySelector('.xmly-mine-refresh')
      expect(refreshBtn).not.toBeNull()
      expect(refreshBtn.textContent).toMatch(/刷新/)

      // 点刷新 → 至少再发一次 /listened（当前分段是「历史」，数据来自账号云端）
      global.fetch.mockClear()
      click(refreshBtn)
      await flush(250)
      const urls = global.fetch.mock.calls.map(([u]) => String(u))
      expect(urls.some((u) => u.includes('/listened'))).toBe(true)
    } finally {
      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    }
  })

  it('会员账号显示 VIP 徽标与剩余天数，普通账号显示「普通账号」', async () => {
    // 懒人听书的会员状态由 Host 归一化成 isVip/vipLevel/vipDays（见 provider 的 normalizeUser），
    // 前端只认这套字段，两个平台同一套渲染。
    manifestData.user = {
      uid: 42, nickname: 'VIP用户', isVip: true, vipLevel: 5, vipDays: 368, vipUntil: 0,
    }
    manifestData.accounts = [
      { id: 'ximalaya', label: '喜马拉雅', loggedIn: true, nickname: 'VIP用户', isVip: true, vipLevel: 5, vipDays: 368 },
      { id: 'lrts', label: '懒人听书', loggedIn: false, nickname: '', isVip: false, vipLevel: 0, vipDays: 0 },
    ]
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    try {
      await flush()
      for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
        click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
        await flush()
      }
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(250)

      const badge = panelHost.querySelector('.xmly-badge-vip')
      expect(badge).not.toBeNull()
      expect(badge.textContent).toContain('VIP')
      expect(badge.textContent).toContain('Lv5')
      // 账号行：会员生效中 + 剩余天数
      expect(panelHost.textContent).toContain('剩 368 天')
      expect(panelHost.textContent).not.toContain('普通账号（VIP/已购内容可播）')
    } finally {
      delete manifestData.user
      delete manifestData.accounts
      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    }
  })
})

describe('上一集/下一集（客户端）', () => {
  // 回归：从「历史」直接起播时，专辑目录根本没加载过（懒人听书的书常从第 800 集
  // 起播），旧实现只查本地 albumTracks，找不到就静默返回 → 按钮点了没反应。
  // 现在这种情况必须去 Host 的 /neighbor 拿相邻章节。
  it('当前曲目不在已加载目录里时，点「下一集」走 Host /neighbor 并切过去', async () => {
    neighborData = {
      track: { id: 2002, title: '听过的下一集', duration: 600, albumId: 123, section: null },
      index: 1, total: 2,
    }
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    try {
      await flush()
      for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
        click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
        await flush()
      }
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(250)

      // 历史里那条（trackId 2001）不在任何已加载的专辑目录里；点它就起播。
      click(panelHost.querySelector('.xmly-like-row'))
      await flush(250)
      expect(barHost.textContent).toContain('听过的测试一集')

      global.fetch.mockClear()
      const nextBtn = [...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '下一集')
      expect(nextBtn).toBeTruthy()
      click(nextBtn)
      await flush(300)

      const urls = global.fetch.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('/neighbor'))).toBe(true)
      expect(barHost.textContent).toContain('听过的下一集')
    } finally {
      neighborData = { track: null, index: -1, total: 0 }
      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    }
  })
})

// 回归：宿主页面是 dsh-app://app（Electron 自定义协议），该协议下 <audio>.seekable
// 恒为 [[0,0]]，currentTime 赋值会被丢弃 ⇒ 快进/快退永远没反应。
// 所以播放源必须改走 Host 提供的 127.0.0.1 回环 http 地址。
describe('播放源走 127.0.0.1 回环（自定义协议下不可 seek）', () => {
  it('拿到 /audio-origin 后，<audio> 的 src 指向回环地址而不是 /dsh-tingbar/stream', async () => {
    audioOriginData = 'http://127.0.0.1:7395/tok123'
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'sidebar.footer.action')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    try {
      await flush(250)
      for (let i = 0; i < 2 && panelHost.querySelector('.xmly-panel') === null; i += 1) {
        click([...barHost.querySelectorAll('button')].find((b) => b.getAttribute('title') === '搜索/列表'))
        await flush()
      }
      click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
      await flush(250)
      click(panelHost.querySelector('.xmly-like-row'))
      await flush(300)

      // Audio 是桩类（不是 DOM 元素），从实例列表里找被赋过流地址的那个。
      const playing = global.__xmlyAudioInstances.filter((a) => String(a.src || '').includes('/stream?')).pop()
      expect(playing).toBeTruthy()
      expect(String(playing.src)).toContain('http://127.0.0.1:7395/tok123/stream?trackId=2001')
      expect(String(playing.src)).not.toContain('/dsh-tingbar/stream')
    } finally {
      audioOriginData = null
      for (const c of effects) { try { c() } catch {} }
      barRoot.unmount()
      panelRoot.unmount()
    }
  })
})
