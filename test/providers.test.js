/**
 * provider 契约测试：两个平台必须实现同一套方法签名，Host 才可能用一份路由代码
 * 同时服务喜马拉雅与懒人听书。这里只校验形状与元数据，不触网。
 */
import { describe, it, expect } from 'vitest'
import {
  PROVIDERS, PLATFORM_IDS, DEFAULT_PLATFORM, isPlatform, providerOf, platformsMeta, labelOf,
} from '../lib/providers/index.js'

const REQUIRED = [
  'id', 'label', 'needsLogin', 'supports',
  'qrCreate', 'qrCheck', 'user', 'search', 'album', 'tracks', 'resolvePlay',
  'streamHeaders', 'errorInfo', 'listened', 'neighbor',
]

describe('providers registry', () => {
  it('注册了两个平台且默认值是合法平台', () => {
    expect(PLATFORM_IDS).toEqual(['ximalaya', 'lrts'])
    expect(isPlatform(DEFAULT_PLATFORM)).toBe(true)
    expect(Object.keys(PROVIDERS).sort()).toEqual(['lrts', 'ximalaya'])
  })

  it('isPlatform 拒绝未知平台', () => {
    expect(isPlatform('ximalaya')).toBe(true)
    expect(isPlatform('lrts')).toBe(true)
    expect(isPlatform('qqmusic')).toBe(false)
    expect(isPlatform('')).toBe(false)
    expect(isPlatform(undefined)).toBe(false)
    expect(isPlatform(null)).toBe(false)
  })

  it('providerOf 返回对应 provider，未知平台回落到默认平台', () => {
    expect(providerOf('lrts').id).toBe('lrts')
    expect(providerOf('ximalaya').id).toBe('ximalaya')
    // 路由对未知平台会先拦下来（400），这里只保证不炸。
    expect(providerOf('nope')).toBeTruthy()
  })

  it('labelOf 给出中文名', () => {
    expect(labelOf('ximalaya')).toBe('喜马拉雅')
    expect(labelOf('lrts')).toBe('懒人听书')
  })

  it('platformsMeta 暴露给前端：id/label/needsLogin/supports', () => {
    const meta = platformsMeta()
    expect(meta.length).toBe(2)
    for (const m of meta) {
      expect(typeof m.id).toBe('string')
      expect(typeof m.label).toBe('string')
      expect(typeof m.needsLogin).toBe('object')
      expect(typeof m.supports).toBe('object')
      expect(m).toHaveProperty('needsLogin.search')
      expect(m).toHaveProperty('needsLogin.play')
      expect(m).toHaveProperty('supports.following')
    }
  })

  it('喜马拉雅匿名可搜可播，懒人听书搜索与播放都需要登录', () => {
    expect(PROVIDERS.ximalaya.needsLogin.search).toBe(false)
    expect(PROVIDERS.ximalaya.needsLogin.play).toBe(false)
    expect(PROVIDERS.lrts.needsLogin.search).toBe(true)
    expect(PROVIDERS.lrts.needsLogin.play).toBe(true)
  })

  it('懒人听书不支持「我的」里的关注/订阅/点赞写操作', () => {
    expect(PROVIDERS.ximalaya.supports.following).toBe(true)
    expect(PROVIDERS.ximalaya.supports.write).toBe(true)
    expect(PROVIDERS.lrts.supports.following).toBe(false)
    expect(PROVIDERS.lrts.supports.subscriptions).toBe(false)
    expect(PROVIDERS.lrts.supports.likes).toBe(false)
    expect(PROVIDERS.lrts.supports.write).toBe(false)
  })

  it('收听历史两个平台都走账号云端（cloudHistory），收藏只有懒人听书有', () => {
    expect(PROVIDERS.ximalaya.supports.cloudHistory).toBe(true)
    expect(PROVIDERS.lrts.supports.cloudHistory).toBe(true)
    expect(PROVIDERS.ximalaya.supports.cloudFavs).toBe(false)
    expect(PROVIDERS.lrts.supports.cloudFavs).toBe(true)
  })

  it('每个 provider 都实现了完整方法集', () => {
    for (const id of PLATFORM_IDS) {
      const p = PROVIDERS[id]
      for (const key of REQUIRED) expect(p[key], id + '.' + key).toBeDefined()
      for (const fn of ['qrCreate', 'qrCheck', 'user', 'search', 'album', 'tracks', 'resolvePlay', 'streamHeaders', 'errorInfo', 'listened', 'neighbor']) {
        expect(typeof p[fn], id + '.' + fn).toBe('function')
      }
      // 流代理要带 UA/Referer 之类的上游头，否则直链会被拒。
      const headers = p.streamHeaders()
      expect(headers).toBeTypeOf('object')
      expect(Object.keys(headers).length).toBeGreaterThan(0)
    }
  })

  it('errorInfo 把错误翻译成 { status, message, needLogin, needVip }', () => {
    const x = PROVIDERS.ximalaya.errorInfo(new Error('boom'))
    expect(x).toHaveProperty('status')
    expect(x).toHaveProperty('message')
    expect(x).toHaveProperty('needLogin')
    expect(x).toHaveProperty('needVip')
    const l = PROVIDERS.lrts.errorInfo(new Error('boom'))
    expect(l).toHaveProperty('status')
    expect(l).toHaveProperty('needLogin')
  })
})
