/**
 * dsh-tingbar client half: the browser player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock and a floating panel (search / album detail / login+favs)
 * that talks to the Host half over plain HTTP (/dsh-tingbar/* routes).
 *
 * Audio is a native <audio> element whose src points at the Host's stream
 * relay (/dsh-tingbar/stream?trackId=...) — no CORS concerns, Range/seek
 * supported, login state stays Host-side. Play prefs (volume / rate /
 * last-playback / panel geometry) persist on the Host, so a refresh (or a
 * dsh-desktop restart with a random port) restores the session.
 *
 * The agent's ximalaya_play tool lands as an "intent" polled every 2s.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tingbar',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    // Web 端构建标记：诊断回到 Host 的 boot 记录里带上它，方便确认页面里跑的是哪一版。
    const CLIENT_BUILD = '0.6.13';

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------
    const fmtTime = (sec) => {
      const s = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
      const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
      const ss = String(r).padStart(2, '0');
      return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    };
    const fmtCount = (n) => {
      const v = Number(n) || 0;
      if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
      if (v >= 10000) return (v / 10000).toFixed(1) + '万';
      return String(v);
    };
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    // ------------------------------------------------------------------
    // store（React 靠 set() 触发重渲染）
    // ------------------------------------------------------------------
    const store = {
      // 平台（喜马拉雅 / 懒人听书）：Host 侧持久化，manifest 回来后水合。
      // platform 决定所有 Host 请求的 ?platform= 参数；platforms 是可选平台元数据，
      // accountList 是两个平台各自的登录态（面板顶部小圆点显示）。
      platform: 'ximalaya', platforms: [], accountList: [],
      // 回环音频源基址（http://127.0.0.1:PORT）。dsh-app:// 下 <audio> 不可 seek，
      // 所以播放一律走这个 http 源；拿不到时退回 dsh-app:// 相对路径。
      audioBase: '',
      manifestReady: false, loggedIn: false, user: null, favs: [], history: [],
      // 云端收听历史（两平台都读自己账号里的那份，手机端与网页端共享）：
      // { trackId, trackTitle, albumId, albumTitle, section, cover, duration, position, updatedAt }
      listens: [], listensLoading: false, listensLoaded: false,
      listensReferId: '', listensPage: 0, listensTotal: 0, listensHasMore: false,
      // 云端收藏（懒人听书）：albums 由 /cloud/favs 拉取，refresh 按钮强制刷新
      cloudFavs: [], cloudFavsLoading: false, cloudFavsError: '', cloudFavsLoaded: false,
      panelOpen: false, panelPos: null, tab: 'search',
      // 搜索页：热搜词（喜马拉雅）+ 排行榜
      searchKw: '', searching: false, searchError: '',
      searchResults: [], searchTotal: 0, searchPage: 1, searchTotalPages: 1, searchDone: false,
      hots: [], hotsLoaded: false,
      showRanks: false, rankCats: [], rankCatsLoaded: false,
      rankCat1: null, rankCat2: null, rankContent: null, rankContentLoading: false,
      // 专辑页
      album: null, albumTracks: [], albumPageId: 1, albumMaxPageId: 1,
      albumTotal: 0, albumLoading: false, albumMore: false, albumFav: false, albumError: '', albumTruncated: false,
      // 登录弹层
      qr: null, qrStatus: '', // '' | 'waiting' | 'expired' | 'loading'
      // 「我的」分段：recent 收听历史 / likes 收藏的声音 / subs 订阅的专辑 /
      // anchors 关注的主播 / albums 本地收藏专辑 / cloudfavs 懒人听书云端收藏
      mineSeg: 'recent',
      likes: { list: [], total: 0, pageNum: 1, hasMore: false, loading: false, error: '' },
      likesLoaded: false,
      subs: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' },
      subsLoaded: false,
      following: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' },
      followingLoaded: false,
      // 主播浏览（从关注列表点进某位主播）
      anchorView: null, anchorAlbums: [], anchorTotal: 0, anchorLoading: false, anchorError: '',
      // 云端订阅状态（id → true 已订阅 / false 未订阅）：订阅列表水合 + 写操作维护
      cloudSubs: {},
      // 播放态
      current: null, // { trackId, trackTitle, albumId, albumTitle, cover, duration, quality }
      playing: false, buffering: false, position: 0, duration: 0,
      volume: 0.9, rate: 1, seekStep: 15, error: '', pendingTrack: null, restored: false,
      // 提示条
      toast: null, // { text, ok }
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      for (const fn of [...listeners]) fn();
    }
    function useStore() {
      const [snap, setSnap] = useState(store);
      useEffect(() => {
        const update = () => setSnap({ ...store });
        listeners.add(update);
        update();
        return () => { listeners.delete(update); };
      }, []);
      return snap;
    }
    function showToast(text, ok = true) {
      set({ toast: { text, ok } });
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => set({ toast: null }), 2200);
    }

    // ------------------------------------------------------------------
    // 远程诊断：把 <audio> 的现场数据回报给 Host（GET /dsh-tingbar/diag 可读）。
    // 起因是「快进快退点了没反应」在命令行完全看不到原因——浏览器里的真实数值
    // （duration / seekable / readyState / error）只有页面自己知道。
    // ------------------------------------------------------------------
    function audioSnapshot() {
      const a = audio;
      let seekable = [];
      try {
        for (let i = 0; i < a.seekable.length; i += 1) seekable.push([a.seekable.start(i), a.seekable.end(i)]);
      } catch (e) { seekable = ['err']; }
      return {
        src: String(a.currentSrc || a.src || '').slice(0, 200),
        audioDuration: Number.isFinite(a.duration) ? a.duration : String(a.duration),
        readyState: a.readyState,
        networkState: a.networkState,
        currentTime: a.currentTime,
        paused: a.paused,
        errorCode: a.error ? a.error.code : 0,
        errorMessage: a.error ? String(a.error.message || '').slice(0, 120) : '',
        seekable,
        storeDuration: store.duration,
        storePosition: store.position,
        platform: store.platform,
        cur: store.current ? {
          trackId: store.current.trackId,
          duration: store.current.duration,
          section: store.current.section,
          albumId: store.current.albumId,
        } : null,
      };
    }
    function diag(evt, extra) {
      apiPost('/dsh-tingbar/diag', { evt, ...audioSnapshot(), ...(extra || {}) }).catch(() => {});
    }
    // 用一个全新 <audio> 元素探测某个 URL 的可跳转性（不看当前播放元素的内部状态）。
    async function probeSeekUrl(url, at) {
      const info = { url: String(url).slice(0, 160), at, steps: [] };
      const waitEvent = (el, name, ms) => new Promise((resolve) => {
        let done = false;
        const finish = (why) => { if (!done) { done = true; resolve(why); } };
        el.addEventListener(name, () => finish(name), { once: true });
        setTimeout(() => finish('timeout'), ms);
      });
      const el = new Audio();
      el.preload = 'auto';
      el.muted = true;
      el.src = url;
      info.steps.push(await waitEvent(el, 'loadedmetadata', 6000));
      info.dur = el.duration;
      info.seekable = (() => { const out = []; for (let i = 0; i < el.seekable.length; i += 1) out.push([el.seekable.start(i), el.seekable.end(i)]); return out; })();
      info.before = el.currentTime;
      try { el.currentTime = at; } catch (e) { info.throw = String((e && e.message) || e); }
      info.immediately = el.currentTime;
      info.steps.push(await waitEvent(el, 'seeked', 3000));
      info.after = el.currentTime;
      info.readyState = el.readyState;
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ }
      return info;
    }
    // Host 下发的诊断指令：seek / step / snapshot（见 index.js 的 /diag/cmd）。
    async function runDiagCmd(cmd) {
      const before = audioSnapshot();
      const op = String((cmd && cmd.op) || '');
      if (op === 'snapshot') { diag('diag-snapshot'); return; }
      if (op === 'seek') {
        const delta = Number(cmd.delta) || store.seekStep;
        seekBy(delta);
        await new Promise((r) => setTimeout(r, 900));
        diag('diag-seek', { delta, before, after: audio.currentTime });
        return;
      }
      if (op === 'step') {
        const dir = Number(cmd.dir) >= 0 ? 1 : -1;
        void step(dir);
        await new Promise((r) => setTimeout(r, 1200));
        diag('diag-step', { dir, before });
        return;
      }
      // 探测任意 URL（例如回环 http 源）的可跳转性。
      if (op === 'probeUrl') {
        const url = String(cmd.url || '');
        if (url === '') { diag('diag-probe', { error: 'no-url' }); return; }
        const info = await probeSeekUrl(url, Number(cmd.at) || 30);
        diag('diag-probe', info);
        return;
      }
      // 用一个全新的 <audio> 元素做同一个 seek，判断是「元素状态坏了」还是「环境不支持」。
      if (op === 'fresh') {
        const at = Number(cmd.at) || 30;
        const src = String(audio.currentSrc || audio.src || '');
        if (src === '') { diag('diag-fresh', { error: 'no-src' }); return; }
        const a2 = new Audio();
        a2.preload = 'auto';
        a2.muted = true;
        a2.src = src;
        const info = { at, src: src.slice(0, 120), steps: [] };
        const waitEvent = (el, name, ms) => new Promise((resolve) => {
          let done = false;
          const finish = (why) => { if (!done) { done = true; resolve(why); } };
          el.addEventListener(name, () => finish(name), { once: true });
          setTimeout(() => finish('timeout'), ms);
        });
        info.steps.push(await waitEvent(a2, 'loadedmetadata', 4000));
        info.dur = a2.duration;
        info.seekable = (() => { const out = []; for (let i = 0; i < a2.seekable.length; i += 1) out.push([a2.seekable.start(i), a2.seekable.end(i)]); return out; })();
        info.before = a2.currentTime;
        try { a2.currentTime = at; } catch (e) { info.throw = String((e && e.message) || e); }
        info.immediately = a2.currentTime;
        info.steps.push(await waitEvent(a2, 'seeked', 3000));
        info.after = a2.currentTime;
        info.readyState = a2.readyState;
        // 顺带测两件事：① 该 URL 在自定义协议下是否真的支持 Range；② 媒体片段 #t= 能否定位。
        try {
          const r2 = await fetch(src, { headers: { Range: 'bytes=100-199' }, cache: 'no-store' });
          info.httpStatus = r2.status;
          info.httpHeaders = {
            acceptRanges: r2.headers.get('accept-ranges'),
            contentRange: r2.headers.get('content-range'),
            contentLength: r2.headers.get('content-length'),
          };
          const buf = await r2.arrayBuffer();
          info.httpBytes = buf.byteLength;
        } catch (e) {
          info.httpError = String((e && e.message) || e);
        }
        try {
          const a3 = new Audio();
          a3.preload = 'metadata';
          a3.muted = true;
          a3.src = src + '#t=' + at;
          const why3 = await waitEvent(a3, 'loadedmetadata', 4000);
          info.fragSteps = [why3];
          info.fragTime = a3.currentTime;
          info.fragSeekable = (() => { const out = []; for (let i = 0; i < a3.seekable.length; i += 1) out.push([a3.seekable.start(i), a3.seekable.end(i)]); return out; })();
          try { a3.pause(); a3.removeAttribute('src'); a3.load(); } catch (e) {}
        } catch (e) {
          info.fragError = String((e && e.message) || e);
        }
        try { a2.pause(); a2.removeAttribute('src'); a2.load(); } catch (e) {}
        diag('diag-fresh', info);
        return;
      }
      diag('diag-unknown', { op });
    }

    // ------------------------------------------------------------------
    // 平台参数：所有 Host 请求都带上当前平台（?platform=ximalaya|lrts）
    // ------------------------------------------------------------------
    // 主播/订阅/收藏声音这类「我的」数据只有喜马拉雅有；懒人听书只做
    // 搜索+专辑+播放，其余按钮由 UI 按 supports 隐藏。
    const platformSuffix = () => 'platform=' + encodeURIComponent(store.platform);
    const apiUrl = (url) => url + (url.indexOf('?') >= 0 ? '&' : '?') + platformSuffix();
    const apiGet = (url) => jsonGet(apiUrl(url));
    const apiPost = (url, body) => jsonPost(apiUrl(url), body);
    // manifest 还没回来（或老版本 Host 不返回 platforms）时的兜底元数据，
    // 保证切换器、登录闸门、文案在首帧就正确，不会先闪一堆「喜马拉雅」。
    const FALLBACK_PLATFORMS = [
      { id: 'ximalaya', label: '喜马拉雅', needsLogin: { search: false, browse: false, play: false, mine: true }, supports: { following: true, likes: true, subscriptions: true, anchor: true, write: true, home: false, hotWords: true, ranks: true } },
      { id: 'lrts', label: '懒人听书', needsLogin: { search: true, browse: false, play: true, mine: true }, supports: { following: false, likes: false, subscriptions: false, anchor: false, write: false, home: true, hotWords: false, ranks: true } },
    ];
    const platformList = () => (store.platforms.length > 0 ? store.platforms : FALLBACK_PLATFORMS);
    const metaOf = (id) => platformList().find((p) => p.id === id) || null;
    const platformLabel = () => (metaOf(store.platform) || {}).label || '喜马拉雅';
    // 会员文案：两平台的会员字段不一样，统一由 Host 归一化成 isVip/vipLevel/vipDays/vipUntil。
    const vipBadge = (user) => {
      if (!user || !user.isVip) return '';
      const lv = Number(user.vipLevel);
      if (lv > 0) return 'VIP Lv' + lv;
      return 'VIP';
    };
    const vipLine = (user) => {
      if (!user || !user.isVip) return '普通账号（VIP/已购内容可播）';
      const days = Number(user.vipDays) || 0;
      const until = Number(user.vipUntil) || 0;
      const lv = Number(user.vipLevel);
      const head = lv > 0 ? 'VIP Lv' + lv + ' 会员生效中' : '会员生效中';
      const tail = [];
      if (days > 0) tail.push('剩 ' + days + ' 天');
      if (until > 0) {
        const d = new Date(until);
        const pad = (n) => (n < 10 ? '0' + n : String(n));
        tail.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' 到期');
      }
      return tail.length > 0 ? head + ' · ' + tail.join(' · ') : head + '，可播会员免费内容';
    };
    const supports = (key) => {
      const m = metaOf(store.platform);
      if (!m || !m.supports) return store.platform === 'ximalaya';
      return !!m.supports[key];
    };
    // 懒人听书「听」和「搜」都要求登录（web 端连免费章节也要登录态）。
    const needsLoginFor = (key, platformId, loggedIn) => {
      const m = metaOf(platformId || store.platform);
      const flags = (m && m.needsLogin) || {};
      return !!flags[key] && !loggedIn;
    };
    const needLoginToSearch = () => needsLoginFor('search', store.platform, store.loggedIn);

    // 切换平台：换内容源 = 面板里的搜索/专辑/主播/我的分页全部清空，
    // 正在播的曲目也停掉（否则「下一集」会拿另一个平台的专辑列表去续播）。
    async function switchPlatform(id) {
      if (!id || id === store.platform) return;
      const label = (metaOf(id) || {}).label || id;
      try { audio.pause(); } catch (e) {}
      try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
      store.platform = id;
      set({
        platform: id,
        panelOpen: true, tab: 'search',
        playing: false, buffering: false, current: null, position: 0, duration: 0, error: '',
        searchKw: '', searching: false, searchError: '',
        searchResults: [], searchTotal: 0, searchPage: 1, searchTotalPages: 1, searchDone: false,
        hots: [], hotsLoaded: false, showRanks: false,
        rankCats: [], rankCatsLoaded: false, rankCat1: null, rankCat2: null, rankContent: null, rankContentLoading: false,
        album: null, albumTracks: [], albumPageId: 1, albumMaxPageId: 1, albumTotal: 0,
        albumLoading: false, albumMore: false, albumFav: false, albumError: '',
        anchorView: null, anchorAlbums: [], anchorTotal: 0, anchorLoading: false, anchorError: '',
        // 默认分段：两个平台都有「收听历史」，优先落在历史页（懒人听书靠它续播）。
        mineSeg: 'recent',
        listens: [], listensLoading: false, listensLoaded: false,
        listensReferId: '', listensPage: 0, listensTotal: 0, listensHasMore: false,
        cloudFavs: [], cloudFavsLoading: false, cloudFavsError: '', cloudFavsLoaded: false,
        likes: { list: [], total: 0, pageNum: 1, hasMore: false, loading: false, error: '' }, likesLoaded: false,
        subs: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, subsLoaded: false,
        following: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, followingLoaded: false,
        cloudSubs: {},
        qr: null, qrStatus: '',
        favs: [], history: [],
      });
      try { await apiPost('/dsh-tingbar/prefs', { prefs: { platform: id } }); } catch (e) {}
      await loadManifest();
      showToast('已切换到' + label);
    }

    // ------------------------------------------------------------------
    // audio engine
    // ------------------------------------------------------------------
    const audio = new Audio();
    audio.preload = 'auto';
    let audioAttached = false;
    // 回环音频源失效（插件热重载换端口）时只自动重取一次基址，防止错误循环。
    let originRetried = false;
    // 静音前的音量，用于取消静音时恢复（不硬编码 0.9）。
    let volBeforeMute = 0.9;

    // 解锁自动播放：用户手势里同步 resume AudioContext，之后的异步 play() 才被放行。
    let unlockCtx = null;
    function unlockAutoplay() {
      try {
        if (unlockCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          unlockCtx = new Ctor();
        }
        if (unlockCtx.state === 'suspended') {
          const p = unlockCtx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* best-effort */ }
    }

    // 流地址：懒人听书解析播放地址需要 tmeId（腾讯资源号）+ section（章节序号），
    // 喜马拉雅只要 trackId；平台非默认时再带上 ?platform=。
    // 走 127.0.0.1 回环 http 源时 <audio> 才可 seek（dsh-app:// 下 seekable 恒为 [[0,0]]）。
    const streamUrl = (trackId, extra) => {
      let u = '/stream?trackId=' + encodeURIComponent(trackId);
      if (store.platform !== 'ximalaya') u += '&' + platformSuffix();
      if (extra && extra.albumId) u += '&albumId=' + encodeURIComponent(extra.albumId);
      if (extra && extra.section !== undefined && extra.section !== null && extra.section !== '') {
        u += '&section=' + encodeURIComponent(extra.section);
      }
      if (extra && extra.tmeId !== undefined && extra.tmeId !== null && extra.tmeId !== '') {
        u += '&tmeId=' + encodeURIComponent(extra.tmeId);
      }
      return store.audioBase !== '' ? store.audioBase + u : '/dsh-tingbar' + u;
    };

    // 播放地址预检：确认可播（登录/权限）并拿到质量标签，再真正起播。
    async function resolvePlay(trackId, albumId, section, tmeId) {
      let url = '/dsh-tingbar/play?trackId=' + encodeURIComponent(trackId);
      if (albumId) url += '&albumId=' + encodeURIComponent(albumId);
      if (section !== undefined && section !== null && section !== '') url += '&section=' + encodeURIComponent(section);
      if (tmeId !== undefined && tmeId !== null && tmeId !== '') url += '&tmeId=' + encodeURIComponent(tmeId);
      const res = await apiGet(url);
      if (!res || res.ok !== true) {
        const err = new Error((res && res.error) || '播放地址获取失败');
        err.needAuth = !!(res && (res.needAuth || res.needLogin || res.needVip));
        throw err;
      }
      return res;
    }

    let saveTimer = null;
    function persistPlayback() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const cur = store.current;
        apiPost('/dsh-tingbar/prefs', {
          prefs: { volume: store.volume, rate: store.rate },
          playback: cur ? {
            albumId: cur.albumId || 0,
            albumTitle: cur.albumTitle || '',
            trackId: cur.trackId,
            trackTitle: cur.trackTitle || '',
            // 懒人听书靠 section 定位章节，刷新后恢复播放要用到。
            section: cur.section,
            cover: cur.cover || '',
            position: audio.currentTime || 0,
            duration: audio.duration || store.duration || 0,
          } : null,
        }).catch(() => {});
      }, 600);
    }
    function persistPanel() {
      apiPost('/dsh-tingbar/prefs', { prefs: { panelOpen: store.panelOpen, panelPos: store.panelPos } })
        .catch(() => {});
    }

    async function playTrack(track, albumCtx, opts = {}) {
      // albumCtx: { id, title } —— 用于连续播放（上/下一集）与面板定位。
      unlockAutoplay();
      const target = {
        trackId: track.id,
        trackTitle: track.title,
        albumId: (albumCtx && albumCtx.id) || (track.albumId || 0),
        albumTitle: (albumCtx && albumCtx.title) || track.albumTitle || '',
        cover: track.cover || (store.album && store.album.cover) || '',
        quality: '',
        // 懒人听书的章节序号：解析播放地址必须带上，否则拿不到 path。
        section: track.section,
        // 懒人听书的播放资源号（腾讯 tmeId）：getListenPath 只认这个，缺了还要回查目录。
        tmeId: track.tmeId || '',
        // 目录/历史条目自带的时长：`<audio>` 元数据就绪前也能显示总时长、能算快进边界。
        duration: Number(track.duration) || 0,
        platform: store.platform,
      };
      try {
        set({ current: target, error: '', pendingTrack: null, playing: false, buffering: true });
        if (store.audioBase === '') await loadAudioOrigin();
        const info = await resolvePlay(track.id, target.albumId, target.section, target.tmeId);
        target.quality = info.quality || '';
        if (Number.isFinite(info.duration) && info.duration > 0) target.duration = info.duration;
        set({ current: { ...target } });
        audio.src = streamUrl(track.id, { albumId: target.albumId, section: target.section, tmeId: target.tmeId });
        audio.playbackRate = store.rate;
        if (opts.position && opts.position > 5) {
          const pos = opts.position;
          const onReady = () => { try { audio.currentTime = Math.min(pos, (audio.duration || pos) - 2) } catch (e) {} };
          audio.addEventListener('loadedmetadata', onReady, { once: true });
        }
        const promise = audio.play();
        set({ playing: true, buffering: false });
        if (promise !== undefined && typeof promise.catch === 'function') {
          promise.catch((err) => {
            if (err && err.name === 'AbortError') return;
            set({ playing: false, error: '浏览器拦截了自动播放，点击▶即可播放' });
          });
        }
        persistPlayback();
      } catch (err) {
        set({
          playing: false, buffering: false,
          error: (err && err.needAuth) ? '该曲目需要登录或已购/VIP 权限（面板「我的」扫码登录）' : '播放失败：' + String((err && err.message) || err),
        });
        if (err && err.needAuth) set({ tab: 'mine', panelOpen: true });
      }
    }

    async function step(dir) {
      const cur = store.current;
      if (cur === null) return;
      diag('step', { dir, albumTracks: store.albumTracks.length, albumId: cur.albumId, section: cur.section });
      const ctx = albumCtxOf() || (cur.albumId ? { id: cur.albumId, title: cur.albumTitle || '' } : null);
      const list = store.albumTracks.filter((t) => t.id !== undefined);
      const idx = list.findIndex((t) => t.id === cur.trackId);
      if (idx >= 0) {
        const nextIdx = idx + dir;
        if (nextIdx >= 0 && nextIdx < list.length) { void playTrack(list[nextIdx], ctx); return; }
        if (nextIdx >= list.length && store.albumPageId < store.albumMaxPageId) {
          const added = await loadMoreTracks();
          if (added > 0) {
            const fresh = store.albumTracks;
            const i2 = fresh.findIndex((t) => t.id === cur.trackId);
            const n2 = i2 + dir;
            if (n2 >= 0 && n2 < fresh.length) { void playTrack(fresh[n2], ctx); return; }
          }
        }
      }
      // 当前曲目不在已加载的目录分页里（从「历史」/搜索结果直接起播的常见情况）：
      // 先静默补载专辑目录，多数情况就能在本地列表里定位下一集；仍找不到再交给 Host。
      if (!cur.albumId) { showToast(dir > 0 ? '没有下一集' : '已经是第一集', false); return; }
      if (store.album === null || String(store.album.id) !== String(cur.albumId)) {
        await openAlbum(cur.albumId, { silent: true });
        const loaded = store.albumTracks.filter((t) => t.id !== undefined);
        const li = loaded.findIndex((t) => t.id === cur.trackId);
        if (li >= 0) {
          const ni = li + dir;
          if (ni >= 0 && ni < loaded.length) { void playTrack(loaded[ni], { id: cur.albumId, title: cur.albumTitle || '' }); return; }
        }
      }
      try {
        let q = '/dsh-tingbar/neighbor?albumId=' + encodeURIComponent(cur.albumId)
          + '&trackId=' + encodeURIComponent(cur.trackId == null ? '' : cur.trackId)
          + '&dir=' + (dir > 0 ? '1' : '-1');
        if (cur.section !== undefined && cur.section !== null && cur.section !== '') {
          q += '&section=' + encodeURIComponent(cur.section);
        }
        const r = await apiGet(q);
        if (r && r.ok === true && r.track) {
          void playTrack(r.track, { id: cur.albumId, title: cur.albumTitle || '' });
          return;
        }
        showToast(dir > 0 ? '已经是最后一集' : '已经是第一集', false);
      } catch (err) {
        showToast('切换失败：' + String((err && err.message) || err), false);
      }
    }
    const albumCtxOf = () => store.album ? { id: store.album.id, title: store.album.title } : null;

    // 快进/快退：按步长在 [0, 总时长] 内跳转。与进度条点选、音量一样，
    // 落在浏览器侧 <audio> 上直接 seek（Host 只负责把步长持久化进 prefs），
    // 播放中与暂停状态均可操作，结果被钳制在进度边界内。
    // 赋值后校验：换集瞬间／缓冲期间浏览器会把 currentTime 丢掉（元素重新 load 时归零），
    // 所以这里不只看一眼就报失败——媒体就绪就再补一次，最多两次，然后才提示。
    function verifySeek(target, from, delta, dur, attempt, seq, at) {
      window.setTimeout(() => {
        if (!Number.isFinite(audio.currentTime)) return;
        if (seq !== undefined && seq !== seekSeq) return; // 期间又点了一次，交还给新的那次
        const now = audio.currentTime;
        // 播放中位置本来就在往前走：允许「已过时间 × 倍速」的漂移，否则正常 seek
        // 会被误判成失败并回退到 target（听感上像倒带 1~2 秒）。
        const elapsed = at === undefined ? 0 : Math.max(0, (performance.now() - at) / 1000);
        const drift = audio.paused ? 0 : elapsed * (audio.playbackRate || 1);
        const budget = 1.5 + drift;
        const missed = Math.abs(now - target) > budget && Math.abs(now - from) > 1;
        if (!missed) { diag('seek', { delta, from, target, dur, after: now, attempt }); return; }
        const ready = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0;
        if (attempt < 1 && ready) {
          const again = Math.min(audio.duration, Math.max(0, target));
          try {
            audio.currentTime = again;
            set({ position: again });
            diag('seek-retry', { delta, from, target: again, after: now, attempt: attempt + 1 });
            verifySeek(again, now, delta, audio.duration, attempt + 1, seq, performance.now());
            return;
          } catch (e) { /* 落到下面的失败提示 */ }
        }
        showToast('跳转没生效（音频还在缓冲），稍后再试', false);
        diag('seek-failed', { delta, from, target, after: now, attempt, readyState: audio.readyState });
      }, 500);
    }

    // 起播换集那一瞬间（src 刚换、元数据还没到）浏览器会丢弃 currentTime 赋值，
    // 旧代码在这里等于「点了没反应」。现在把点击攒起来，等媒体就绪后一次性补上。
    let seekSeq = 0;
    let pendingSeekDelta = 0;
    let seekWaiterBound = false;
    function flushPendingSeek() {
      if (pendingSeekDelta === 0) return;
      const delta = pendingSeekDelta;
      pendingSeekDelta = 0;
      if (!(Number.isFinite(audio.duration) && audio.duration > 0)) {
        diag('seek-flush-abort', { delta, readyState: audio.readyState });
        return;
      }
      const from = audio.currentTime;
      const base = Number.isFinite(store.position) ? store.position : from;
      const target = Math.min(audio.duration, Math.max(0, base));
      try {
        audio.currentTime = target;
        set({ position: target });
        persistPlayback();
        diag('seek-flushed', { delta, from, target, dur: audio.duration });
      } catch (e) {
        diag('seek-flush-error', { delta, message: String((e && e.message) || e) });
      }
    }
    function bindSeekWaiter() {
      if (seekWaiterBound) return;
      seekWaiterBound = true;
      const onReady = () => { if (pendingSeekDelta !== 0) flushPendingSeek(); };
      audio.addEventListener('loadedmetadata', onReady);
      audio.addEventListener('canplay', onReady);
    }

    function seekBy(delta) {
      const cur = store.current;
      if (cur === null) return; // 没有曲目，无从跳转
      // 总时长按可靠度回退：<audio> 元数据 → store 快照 → 起播时记录的章节时长
      // → seekable 终点。旧实现在这里「时长未知就直接 return」，元数据还没就绪
      // 时按钮点了毫无反应（这次就是被这一点坑到）。
      let dur = 0;
      if (Number.isFinite(audio.duration) && audio.duration > 0) dur = audio.duration;
      else if (store.duration > 0) dur = store.duration;
      else if (Number(cur.duration) > 0) dur = Number(cur.duration);
      else if (audio.seekable && audio.seekable.length > 0) {
        dur = audio.seekable.end(audio.seekable.length - 1);
      }
      const from = Number.isFinite(audio.currentTime) ? audio.currentTime : (store.position || 0);

      // 元数据没就绪就别急着赋值（浏览器会丢弃）：先记账，等 loadedmetadata/canplay 再补。
      const seekReady = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0;
      const seekLoading = audio.networkState === 1 || audio.networkState === 2;
      if (!seekReady && seekLoading) {
        const base = Number.isFinite(store.position) ? store.position : from;
        const hint = dur > 0 ? Math.min(dur, Math.max(0, base + delta)) : Math.max(0, base + delta);
        pendingSeekDelta += delta;
        bindSeekWaiter();
        // UI 先记到目标位置（不然连点等于没反应），真正的 seek 等媒体就绪再补。
        set({ position: hint });
        persistPlayback();
        diag('seek-defer', { delta, dur, from, hint, pendingSeekDelta, readyState: audio.readyState });
        showToast('音频还在加载，就绪后自动跳转', false);
        return;
      }

      const raw = from + delta;
      const target = dur > 0 ? Math.min(dur, Math.max(0, raw)) : Math.max(0, raw);
      if (Math.abs(target - from) < 0.25) { diag('seek-noop', { delta, from, target, dur }); return; } // 已经到头，不用动
      const seq = ++seekSeq;
      try { audio.currentTime = target; } catch (e) {
        showToast('这个音频暂时不能跳转：' + String((e && e.message) || e), false);
        return;
      }
      // 立即同步 store：时间显示与进度条填充马上更新（不等 timeupdate）。
      set({ position: target });
      persistPlayback();
      verifySeek(target, from, delta, dur, 0, seq, performance.now());
    }

    // 播放/暂停切换（播放条按钮用；面板不再放重复的播放控制——位置钳制后
    // 面板不会盖住播放条，底部按钮始终可点）。
    function togglePlayPause() {
      unlockAutoplay();
      if (store.current === null) {
        set({ panelOpen: true, tab: 'search' });
        return;
      }
      if (audio.paused) {
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
      } else {
        audio.pause();
      }
    }

    // 面板位置/高度钳制：面板卡片不得压到聊天输入区（播放条按钮在那里，
    // 盖住后播放条会"点不动"）。底部预留输入区高度，最小高度之外收敛。
    const PANEL_RESERVE_BOTTOM = 180;
    const PANEL_MIN_H = 320;
    function clampPanelPos(pos) {
      const w = window.innerWidth, h = window.innerHeight;
      const x = Math.max(8, Math.min(w - 120, Math.round(pos.x)));
      const maxY = Math.max(72, h - PANEL_RESERVE_BOTTOM - PANEL_MIN_H);
      const y = Math.max(8, Math.min(maxY, Math.round(pos.y)));
      return { x, y };
    }

    // ------------------------------------------------------------------
    // network: manifest / search / album / fav / prefs / qr
    // ------------------------------------------------------------------
    // 回环音频源：dsh-app:// 下 <audio> 不可 seek，播放前先向 Host 要 127.0.0.1 基址。
    async function loadAudioOrigin() {
      try {
        const res = await jsonGet('/dsh-tingbar/audio-origin');
        if (res && res.ok === true && typeof res.base === 'string' && res.base !== '') {
          store.audioBase = res.base;
        }
      } catch (e) { /* 拿不到就用相对路径兜底 */ }
    }

    async function loadManifest() {
      await loadAudioOrigin();
      try {
        // manifest 不带 ?platform=：让 Host 用它持久化的当前平台回答（否则
        // 刷新后客户端默认 ximalaya 会把用户上次选的懒人听书覆盖掉）。
        const res = await jsonGet('/dsh-tingbar/manifest');
        if (!res || res.ok !== true) return;
        if (typeof res.platform === 'string' && res.platform !== '') store.platform = res.platform;
        set({
          manifestReady: true,
          platform: res.platform || store.platform,
          platforms: Array.isArray(res.platforms) ? res.platforms : [],
          accountList: Array.isArray(res.accounts) ? res.accounts : [],
          loggedIn: !!res.loggedIn, user: res.user || null,
          favs: res.favs || [], history: res.history || [],
          // 收听历史来自账号云端，切平台/登录态变化时重新拉，所以这里只重置缓存标记。
          listens: [], listensLoading: false, listensLoaded: false,
          listensReferId: '', listensPage: 0, listensTotal: 0, listensHasMore: false,
        });
        const prefs = res.prefs || {};
        if (typeof prefs.volume === 'number') { store.volume = prefs.volume; audio.volume = prefs.volume; }
        if (typeof prefs.rate === 'number') { store.rate = prefs.rate; audio.playbackRate = prefs.rate; }
        if (typeof prefs.seekStep === 'number' && Number.isFinite(prefs.seekStep)) {
          store.seekStep = Math.min(120, Math.max(5, Math.round(prefs.seekStep)));
        }
        if (prefs.panelPos && typeof prefs.panelPos.x === 'number') store.panelPos = clampPanelPos(prefs.panelPos);
        // 恢复上次播放（不自动播，点 ▶ 续听）。
        const pb = res.playback;
        if (pb && pb.trackId && !store.current) {
          set({
            current: {
              trackId: pb.trackId, trackTitle: pb.trackTitle || '',
              albumId: pb.albumId || 0, albumTitle: pb.albumTitle || '',
              cover: pb.cover || '', quality: '',
              section: pb.section, platform: store.platform,
            },
            restored: true, position: pb.position || 0, duration: pb.duration || 0,
          });
          audio.src = streamUrl(pb.trackId, { albumId: pb.albumId, section: pb.section });
          const pos = pb.position || 0;
          audio.addEventListener('loadedmetadata', () => {
            try { if (pos > 5) audio.currentTime = Math.min(pos, (audio.duration || pos) - 2); } catch (e) {}
          }, { once: true });
          // 恢复专辑上下文（静默预载目录）：否则刷新后 store.albumTracks 为空，
          // 一集播完 step(1) 找不到当前集只能退到 /neighbor（慢，且曾因宿主旧代码失败）。
          if (pb.albumId) void openAlbum(pb.albumId, { silent: true });
        }
        set({ manifestReady: true });
      } catch { /* 后端未就绪时静默 */ }
    }

    async function doSearch(kw, page = 1) {
      const q = (kw || '').trim();
      if (q === '') return;
      set({ searching: true, searchError: '', searchKw: q, showRanks: false });
      try {
        const res = await apiGet('/dsh-tingbar/search?kw=' + encodeURIComponent(q) + '&page=' + page);
        if (!res || res.ok !== true) throw new Error((res && res.error) || '搜索失败');
        const merged = page > 1 ? store.searchResults.concat(res.albums || []) : (res.albums || []);
        set({
          searching: false,
          searchResults: merged,
          searchTotal: res.total || 0,
          searchPage: res.page || page,
          searchTotalPages: res.totalPages || 1,
          searchDone: (res.page || page) >= (res.totalPages || 1) || (res.albums || []).length === 0,
        });
      } catch (err) {
        set({ searching: false, searchError: String((err && err.message) || err) });
      }
    }

    // ---- 发现：热搜词 / 排行榜（喜马拉雅匿名接口）----
    async function loadHots() {
      if (!supports('hotWords') || store.hotsLoaded) return;
      try {
        const res = await apiGet('/dsh-tingbar/hots');
        if (res && res.ok === true) set({ hots: Array.isArray(res.hots) ? res.hots : [], hotsLoaded: true });
        else set({ hotsLoaded: true });
      } catch { set({ hotsLoaded: true }); }
    }

    async function loadRankCats() {
      if (!supports('ranks') || store.rankCatsLoaded) return;
      try {
        const res = await apiGet('/dsh-tingbar/rank/cats');
        if (!res || res.ok !== true || !Array.isArray(res.tabs)) throw new Error((res && res.error) || '获取榜单分类失败');
        const tabs = res.tabs;
        // 默认选中第一个分类的第一个子榜单。
        const first = tabs[0] || { id: 0, wraps: [] };
        const firstWrap = first.wraps[0] || null;
        set({
          rankCats: tabs,
          rankCatsLoaded: true,
          rankCat1: store.rankCat1 == null ? first.id : store.rankCat1,
          rankCat2: store.rankCat2 == null ? (firstWrap ? firstWrap.rankingId : null) : store.rankCat2,
        });
        if (firstWrap) void loadRankContent(firstWrap.rankingId);
      } catch (err) {
        set({ rankCatsLoaded: true });
        showToast(String((err && err.message) || err), false);
      }
    }

    async function loadRankContent(cat) {
      if (!supports('ranks') || !cat) return;
      set({ rankContentLoading: true });
      try {
        const res = await apiGet('/dsh-tingbar/rank/content?cat=' + encodeURIComponent(cat));
        if (!res || res.ok !== true) throw new Error((res && res.error) || '获取榜单内容失败');
        set({ rankContent: res, rankContentLoading: false });
      } catch (err) {
        set({ rankContentLoading: false, rankContent: null });
        showToast(String((err && err.message) || err), false);
      }
    }

    async function openAlbum(albumId, opts = {}) {
      // silent：面板未打开时后台预载（不切 tab、不打扰当前视图）。
      const switchTab = !(opts.silent && !store.panelOpen);
      set({
        ...(opts.panelOpen ? { panelOpen: true } : {}),
        ...(switchTab ? { tab: 'album' } : {}),
        albumLoading: true, albumError: '', album: null, albumTracks: [], albumTotal: 0, albumPageId: 1, albumMaxPageId: 1, albumFav: false,
      });
      try {
        const [info, list] = await Promise.all([
          apiGet('/dsh-tingbar/album?id=' + encodeURIComponent(albumId)),
          apiGet('/dsh-tingbar/tracks?albumId=' + encodeURIComponent(albumId) + '&pageId=1&pageSize=30'),
        ]);
        if (!info || info.ok !== true) throw new Error((info && info.error) || '专辑获取失败');
        if (!list || list.ok !== true) throw new Error((list && list.error) || '曲目列表获取失败');
        // show 级联接口（部分播客类专辑）不返回 totalCount：回退专辑详情的 trackCount。
        const totalFallback = (info.album && info.album.trackCount) || (list.tracks || []).length;
        set({
          albumLoading: false,
          album: info.album,
          albumTracks: list.tracks || [],
          albumPageId: list.pageId || 1,
          albumMaxPageId: list.maxPageId || 1,
          albumTotal: list.totalCount > 0 ? list.totalCount : totalFallback,
          albumFav: store.favs.some((f) => f.id === albumId),
          albumTruncated: !!list.truncated,
        });
        if (opts.autoAdvanceTo) {
          const cur = store.current;
          const idx = (list.tracks || []).findIndex((t) => t.id === opts.autoAdvanceTo);
          if (idx >= 0) {
            const nextIdx = idx + (opts.dir || 1);
            if (nextIdx >= 0 && nextIdx < list.tracks.length) {
              void playTrack(list.tracks[nextIdx], { id: albumId, title: info.album.title });
            }
          }
        }
        // 已登录且订阅状态未水合：静默拉一次，专辑页「订阅/已订阅」按钮才能显示正确状态。
        if (store.loggedIn && !store.subsLoaded) void loadSubs(1);
      } catch (err) {
        set({ albumLoading: false, albumError: String((err && err.message) || err) });
      }
    }

    async function loadMoreTracks() {
      if (store.album === null || store.albumPageId >= store.albumMaxPageId) return 0;
      const nextPage = store.albumPageId + 1;
      set({ albumMore: true });
      try {
        const list = await apiGet('/dsh-tingbar/tracks?albumId=' + encodeURIComponent(store.album.id) + '&pageId=' + nextPage + '&pageSize=30');
        if (!list || list.ok !== true) { set({ albumMore: false }); return 0; }
        // 防重：上游偶尔会重复返回同一页（懒人听书服务端忽略 pageNo 的历史行为），
        // 按 id 去重，避免列表里出现重复行与重复 key。
        const seen = new Set(store.albumTracks.map((t) => t.id));
        const fresh = (list.tracks || []).filter((t) => !seen.has(t.id));
        set({
          albumMore: false,
          albumTracks: store.albumTracks.concat(fresh),
          albumPageId: list.pageId || nextPage,
          albumMaxPageId: list.maxPageId || 1,
          albumTruncated: !!list.truncated,
        });
        return fresh.length;
      } catch {
        set({ albumMore: false });
        return 0;
      }
    }

    async function toggleFav(album) {
      const active = store.favs.some((f) => f.id === album.id);
      const res = await apiPost('/dsh-tingbar/fav', { album, remove: active });
      if (res && res.ok === true) {
        set({ favs: res.favs || [], albumFav: !active });
        showToast(active ? '已取消收藏' : '已收藏「' + (album.title || '').slice(0, 20) + '」');
      } else {
        showToast('收藏操作失败', false);
      }
    }

    // ---- 云端收听历史（两平台账号里那份，和手机端共享）----
    // 喜马拉雅按 pageNum 翻页（每页 ~100 条），懒人听书按 referId 游标。
    async function loadListens(more = false, force = false) {
      if (!store.loggedIn || store.listensLoading) return;
      if (!more && !force && store.listensLoaded) return;
      const nextPage = more ? store.listensPage + 1 : 1;
      set({ listensLoading: true });
      try {
        let url = '/dsh-tingbar/listened?pageSize=30&pageNum=' + nextPage;
        if (store.platform !== 'ximalaya' && store.listensReferId !== '') {
          url += '&referId=' + encodeURIComponent(store.listensReferId);
        }
        const res = await apiGet(url);
        if (!res || res.ok !== true) throw new Error((res && res.error) || '获取收听历史失败');
        const items = Array.isArray(res.items) ? res.items : [];
        const seen = new Set(more ? store.listens.map((x) => String(x.trackId) + ':' + String(x.albumId)) : []);
        const fresh = items.filter((x) => !seen.has(String(x.trackId) + ':' + String(x.albumId)));
        set({
          listens: more ? store.listens.concat(fresh) : fresh,
          listensLoading: false, listensLoaded: true,
          listensPage: nextPage,
          listensReferId: String(res.referId || ''),
          listensTotal: Number(res.totalCount) || 0,
          // 优先信 Host 透传的 hasMore（懒人按 referId 游标、喜马拉雅上游不翻页），
          // 老版本 Host 没这个字段时回退到本地推断。
          listensHasMore: typeof res.hasMore === 'boolean'
            ? res.hasMore
            : fresh.length > 0 && items.length >= 30,
        });
      } catch (err) {
        set({ listensLoading: false, listensLoaded: true });
        showToast(String((err && err.message) || err), false);
      }
    }

    // ---- 登录用户信息（含会员状态）：/user ----
    // manifest 里的 user 来自 Host 持久化状态，可能是上一次的；进「我的」时拉一次，
    // 保证 VIP 到期/续费后能立刻反映（懒人听书的会员判定靠 vipExpireTime，见 provider）。
    async function loadUser() {
      if (!store.loggedIn) return;
      try {
        const res = await apiGet('/dsh-tingbar/user');
        if (!res || res.ok !== true || !res.user) return;
        const accounts = store.accountList.map((a) => (a.id === store.platform
          ? {
              ...a,
              loggedIn: true,
              nickname: res.user.nickname || a.nickname,
              isVip: !!res.user.isVip,
              vipLevel: Number(res.user.vipLevel) || 0,
              vipDays: Number(res.user.vipDays) || 0,
            }
          : a));
        set({ user: res.user, accountList: accounts });
      } catch (err) {
        // 会员信息拿不到不影响其它功能，静默失败。
      }
    }

    // ---- 云端收藏（懒人听书）：/cloud/favs ----
    async function loadCloudFavs(force = false) {
      if (store.cloudFavsLoading) return;
      if (!force && store.cloudFavsLoaded) return;
      set({ cloudFavsLoading: true, cloudFavsError: '' });
      try {
        const res = await apiGet('/dsh-tingbar/cloud/favs' + (force ? '&refresh=1' : ''));
        if (!res || res.ok !== true) throw new Error((res && res.error) || '获取收藏失败');
        set({
          cloudFavs: Array.isArray(res.albums) ? res.albums : [],
          cloudFavsLoading: false, cloudFavsLoaded: true, cloudFavsError: '',
        });
      } catch (err) {
        set({ cloudFavsLoading: false, cloudFavsLoaded: true, cloudFavsError: String((err && err.message) || err) });
      }
    }

    // ---- 收藏的声音 / 已关注的主播 / 主播浏览 ----
    async function loadLikes(pageNum = 1) {
      if (!store.loggedIn || store.likes.loading) return;
      set({ likes: { ...store.likes, loading: true, error: '' } });
      try {
        const res = await apiGet('/dsh-tingbar/likes?pageNum=' + pageNum + '&pageSize=30');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取收藏的声音失败');
        }
        const merged = pageNum > 1 ? store.likes.list.concat(res.tracks || []) : (res.tracks || []);
        set({
          likes: {
            list: merged, total: res.total || 0, pageNum: res.pageNum || pageNum,
            hasMore: !!res.hasMore, loading: false, error: '',
          },
          likesLoaded: true,
        });
      } catch (err) {
        set({ likes: { ...store.likes, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function loadFollowing(page = 1) {
      if (!store.loggedIn || store.following.loading) return;
      set({ following: { ...store.following, loading: true, error: '' } });
      try {
        const res = await apiGet('/dsh-tingbar/following?page=' + page + '&pageSize=20');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取关注列表失败');
        }
        const merged = page > 1 ? store.following.list.concat(res.anchors || []) : (res.anchors || []);
        const total = res.total || 0;
        set({
          following: {
            list: merged, total, page: res.page || page,
            hasMore: merged.length < total, loading: false, error: '',
          },
          followingLoaded: true,
        });
      } catch (err) {
        set({ following: { ...store.following, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function loadSubs(page = 1) {
      if (!store.loggedIn || store.subs.loading) return;
      set({ subs: { ...store.subs, loading: true, error: '' } });
      try {
        const res = await apiGet('/dsh-tingbar/subscriptions?page=' + page + '&pageSize=30');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取订阅列表失败');
        }
        const merged = page > 1 ? store.subs.list.concat(res.albums || []) : (res.albums || []);
        const total = res.total || 0;
        // 水合云端订阅状态（专辑页的「订阅/已订阅」按钮用）。
        const cloudSubs = { ...store.cloudSubs };
        for (const a of merged) cloudSubs[a.id] = true;
        set({
          subs: {
            list: merged, total, page: res.page || page,
            hasMore: merged.length < total, loading: false, error: '',
          },
          subsLoaded: true,
          cloudSubs,
        });
      } catch (err) {
        set({ subs: { ...store.subs, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function openAnchor(anchor) {
      set({
        anchorView: anchor, anchorAlbums: [], anchorTotal: 0,
        anchorLoading: true, anchorError: '', tab: 'anchor', panelOpen: true,
      });
      try {
        const res = await apiGet('/dsh-tingbar/anchor?uid=' + encodeURIComponent(anchor.uid));
        if (!res || res.ok !== true) throw new Error((res && res.error) || '获取主播专辑失败');
        set({ anchorAlbums: res.albums || [], anchorTotal: res.total || 0, anchorLoading: false });
      } catch (err) {
        set({ anchorLoading: false, anchorError: String((err && err.message) || err) });
      }
    }

    // 云端写操作（Host 转发网页端写接口）：返回 { ok, msg?, error?, needLogin? }。
    async function cloudWrite(op, id, on) {
      try {
        const res = await apiPost('/dsh-tingbar/write', { op, id, on });
        if (res && res.ok === true) return { ok: true, msg: res.msg || '' };
        return { ok: false, error: (res && res.error) || '操作失败', needLogin: !!(res && res.needLogin) };
      } catch {
        return { ok: false, error: '网络错误，请稍后重试' };
      }
    }

    function cloudFail(r) {
      if (r.needLogin) { set({ tab: 'mine', panelOpen: true }); showToast('请先在「我的」页扫码登录', false); }
      else showToast(r.error || '操作失败', false);
    }

    // 取消收藏声音（云端同步：手机 App 收藏列表同步移除）。
    async function unlikeTrack(t) {
      const r = await cloudWrite('like', t.id, false);
      if (!r.ok) { cloudFail(r); return; }
      set({
        likes: {
          ...store.likes,
          list: store.likes.list.filter((x) => x.id !== t.id),
          total: Math.max(0, store.likes.total - 1),
        },
      });
      showToast('已取消收藏：' + (t.title || '').slice(0, 18));
    }

    // 订阅/退订专辑（云端同步，两个方向均可纯接口完成）。
    async function toggleSubscribe(album, trackCount) {
      const on = !store.cloudSubs[album.id];
      const r = await cloudWrite('sub', album.id, on);
      if (!r.ok) { cloudFail(r); return; }
      const cloudSubs = { ...store.cloudSubs, [album.id]: on };
      let list = store.subs.list;
      let total = store.subs.total;
      if (on) {
        list = [{ id: album.id, title: album.title || '', cover: album.cover || '', trackCount: trackCount || 0, isPaid: !!album.isPaid, isFinished: !!album.isFinished, anchorName: album.anchorName || '', category: album.category || '', lastTrackTitle: '', lastUpdateText: '' }, ...list];
        total = total + 1;
      } else {
        list = list.filter((a) => a.id !== album.id);
        total = Math.max(0, total - 1);
      }
      set({ cloudSubs, subs: { ...store.subs, list, total } });
      showToast(on ? '已订阅「' + (album.title || '').slice(0, 16) + '」（云端同步）' : '已退订「' + (album.title || '').slice(0, 16) + '」');
    }

    // 取消关注主播（云端同步）。
    async function unfollowAnchor(anchor) {
      const r = await cloudWrite('follow', anchor.uid, false);
      if (!r.ok) { cloudFail(r); return; }
      set({
        following: {
          ...store.following,
          list: store.following.list.filter((a) => a.uid !== anchor.uid),
          total: Math.max(0, store.following.total - 1),
        },
      });
      showToast('已取消关注：' + (anchor.nickname || '').slice(0, 16));
    }

    async function startQrLogin() {
      set({ qrStatus: 'loading', qr: null });
      try {
        const res = await apiPost('/dsh-tingbar/qr/create', {});
        if (!res || res.ok !== true) throw new Error((res && res.error) || '二维码获取失败');
        set({ qr: res, qrStatus: 'waiting' });
      } catch (err) {
        set({ qrStatus: '', qr: null });
        showToast('二维码获取失败：' + String((err && err.message) || err), false);
      }
    }
    async function pollQr() {
      if (store.qr === null || store.qrStatus !== 'waiting') return;
      // 喜马拉雅用 qrId、懒人听书用 sceneToken 轮询，取有的那个。
      const token = store.qr.qrId || store.qr.sceneToken || '';
      try {
        const res = await apiGet('/dsh-tingbar/qr/check?qrId=' + encodeURIComponent(token));
        if (!res || res.ok !== true) return;
        if (res.status === 'success') {
          set({ qr: null, qrStatus: '', loggedIn: true, user: res.user || null });
          showToast('登录成功' + (res.user && res.user.nickname ? '，欢迎 ' + res.user.nickname : ''));
          void loadManifest();
        } else if (res.status === 'expired') {
          set({ qr: null, qrStatus: 'expired' });
        }
      } catch { /* 轮询失败忽略，下次再试 */ }
    }

    // ------------------------------------------------------------------
    // intent 轮询（agent 工具触发的播放/控制）
    // ------------------------------------------------------------------
    async function handleIntent(intent) {
      if (intent === null || typeof intent !== 'object') return;
      const action = intent.action || 'play';
      // 远程诊断：Host 下发一次性指令，Web 端执行后把现场数据回报（排查真实播放问题用）。
      if (action === 'diag') { await runDiagCmd(intent.cmd || {}); return; }
      if (action === 'pause') { audio.pause(); set({ playing: false }); return; }
      if (action === 'resume') {
        unlockAutoplay();
        const p = audio.play();
        if (p && p.catch) p.catch(() => { set({ error: '浏览器拦截了自动播放，点击▶即可播放' }); });
        return;
      }
      if (action === 'stop') {
        try { audio.pause(); } catch (e) {}
        audio.removeAttribute('src'); try { audio.load(); } catch (e) {}
        set({ playing: false, current: null, position: 0, duration: 0 });
        return;
      }
      if (action === 'next') { void step(1); return; }
      if (action === 'prev') { void step(-1); return; }
      // play：优先 trackId；带 albumId 时顺便把专辑载进面板（保证连续播放上下文）。
      // 工具传了 platform 且与面板当前平台不同：先切平台再播（否则会拿错内容源）。
      if (typeof intent.platform === 'string' && intent.platform !== '' && intent.platform !== store.platform) {
        await switchPlatform(intent.platform);
      }
      if (typeof intent.trackId === 'number' && intent.trackId > 0) {
        const track = {
          id: intent.trackId,
          title: intent.trackTitle || ('曲目 #' + intent.trackId),
          albumId: intent.albumId || 0,
          albumTitle: intent.albumTitle || '',
          cover: '',
          section: intent.section,
        };
        if (intent.albumId) {
          // 面板没开时静默预载专辑（供连续播放/稍后浏览），不切换 tab——
          // 否则用户下次点 🔎 会莫名落在专辑页。
          void openAlbum(intent.albumId, { silent: true });
        }
        void playTrack(track, intent.albumId ? { id: intent.albumId, title: intent.albumTitle || '' } : null);
        if (store.restored) set({ restored: false });
      }
    }

    // ------------------------------------------------------------------
    // UI: 播放条
    // ------------------------------------------------------------------
    function ProgressBar({ compact }) {
      const s = useStore();
      const dur = s.duration || (s.current && s.current.duration) || 0;
      const pct = dur > 0 ? Math.min(1, s.position / dur) : 0;
      const seek = (ev) => {
        const el = ev.currentTarget;
        const r = el.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        if (dur > 0) {
          const target = ratio * dur;
          try { audio.currentTime = target; } catch (e) {}
          // 乐观更新进度显示；500ms 后校验一次，没生效（比如刚换集元数据未就绪）
          // 就提示，避免「点了没反应」的静默失败 —— 与 seekBy 的守护策略一致。
          set({ position: target });
          const seq = ++seekSeq;
          setTimeout(() => {
            if (seq !== seekSeq) return;
            const at = Math.abs((audio.currentTime || 0) - target) > 2 && dur > 0;
            if (at && !audio.paused) showToast('跳转没生效（音频还在缓冲），稍后再试', false);
          }, 500);
        }
      };
      return React.createElement('div', {
        className: 'xmly-progress' + (compact ? ' xmly-progress-compact' : ''),
        onClick: seek,
        title: dur > 0 ? fmtTime(s.position) + ' / ' + fmtTime(dur) : '',
      }, [
        React.createElement('div', { key: 'fill', className: 'xmly-progress-fill', style: { width: (pct * 100).toFixed(2) + '%' } }),
      ]);
    }

    function VolumePopup() {
      const s = useStore();
      const pct = Math.round((s.volume || 0) * 100) + '%';
      // 常显内联音量条：直接显示在音量按钮右侧、占满中间空白；无内部喇叭图标
      return React.createElement('div', { className: 'xmly-vol-inline' }, [
        React.createElement('input', {
          key: 'r', type: 'range', min: 0, max: 1, step: 0.01, value: s.volume,
          style: { '--vol-pct': pct },
          onChange: (ev) => { const v = Number(ev.target.value); audio.volume = v; set({ volume: v }); },
          onMouseUp: () => persistPlayback(), onTouchEnd: () => persistPlayback(),
        }),
      ]);
    }

    const RATES = [1, 1.25, 1.5, 2, 0.75];
    const STEP_CHOICES = [5, 10, 15, 30, 60];
    function StepPopup() {
      const s = useStore();
      return React.createElement('div', { className: 'xmly-pop xmly-step-pop' }, [
        React.createElement('div', { key: 'label', className: 'xmly-step-label' }, '快进/快退步长'),
        React.createElement('div', { key: 'choices', className: 'xmly-step-choices' },
          STEP_CHOICES.map((n) => React.createElement('button', {
            key: n, className: 'xmly-chip' + (s.seekStep === n ? ' active' : ''),
            onClick: () => {
              set({ seekStep: n });
              apiPost('/dsh-tingbar/prefs', { prefs: { seekStep: n } }).catch(() => {});
            },
          }, n + ' 秒'))),
      ]);
    }
    function NowPlayingBar(props) {
      const wide = !props || props.wide !== false; // 折叠成 56px 竖条时 wide=false
      const s = useStore();
      const [pop, setPop] = useState(''); // '' | 'step'
      const [coverErr, setCoverErr] = useState('');
      const barRef = useRef(null);
      const cur = s.current;
      const dur = s.duration || (cur && cur.duration) || 0;
      const coverUrl = cur && cur.cover ? cur.cover : '';
      useEffect(() => { setCoverErr(''); }, [coverUrl]);

      const openFromBar = () => {
        // 有点播上下文：直接打开（并加载）当前曲目的专辑页；否则去搜索。
        if (cur && cur.albumId) {
          if (store.album && store.album.id === cur.albumId) set({ panelOpen: true, tab: 'album' });
          else void openAlbum(cur.albumId, { panelOpen: true });
        } else {
          set({ panelOpen: true, tab: 'search' });
        }
      };

      // 折叠成竖条（56px）时：只给一个图标按钮，避免 8 键横排溢出。
      if (!wide) {
        return React.createElement('div', { className: 'xmly-bar-wrap xmly-rail' },
          React.createElement('button', {
            className: 'xmly-rail-btn' + (cur ? '' : ' xmly-rail-idle'),
            title: cur
              ? (cur.trackTitle || '') + (s.playing ? ' · 暂停' : ' · 播放')
              : platformLabel() + ' · 点此打开播放器',
            onClick: () => {
              if (cur) { unlockAutoplay(); togglePlayPause(); }
              else set({ panelOpen: true, tab: 'search' });
            },
          }, cur ? (s.buffering ? '⋯' : (s.playing ? '⏸' : '▶')) : '📻'));
      }

      return React.createElement('div', { className: 'xmly-bar-wrap xmly-sidebar' },
        React.createElement('div', { className: 'xmly-bar' + (cur ? '' : ' xmly-bar-idle'), ref: barRef }, [
          React.createElement('div', { key: 'head', className: 'xmly-bar-head', onClick: openFromBar }, [
            coverUrl && coverErr !== coverUrl
              ? React.createElement('img', { key: 'cover', className: 'xmly-bar-cover', src: coverUrl, alt: '', onError: () => setCoverErr(coverUrl) })
              : React.createElement('span', { key: 'note', className: 'xmly-note' }, cur ? '🎧' : '📻'),
            React.createElement('div', { key: 'title', className: 'xmly-bar-title' }, [
              cur
                ? React.createElement('span', { key: 't', className: 'xmly-bar-track', title: cur.trackTitle }, cur.trackTitle)
                : React.createElement('span', { key: 't', className: 'xmly-bar-track xmly-bar-hint' }, platformLabel() + ' · 点「搜索」找节目'),
              cur && cur.albumTitle
                ? React.createElement('span', { key: 'a', className: 'xmly-bar-album', title: cur.albumTitle }, cur.albumTitle + (cur.quality ? ' · ' + cur.quality.replace(/ ?kbps ?/, 'k ') : ''))
                : null,
            ]),
          ]),
          s.error
            ? React.createElement('span', { key: 'err', className: 'xmly-bar-warn', onClick: () => set({ error: '', tab: 'mine', panelOpen: true }) }, s.error.slice(0, 30))
            : null,
          // 媒体符号统一用文本变体选择符 \uFE0E 渲染成单色字形，才能吃 CSS color（悬停变色）；
          // 否则 ⏪/⏩ 会被渲染成彩色 emoji，忽略 :hover 的 color，导致与上一集/下一集样式不一致。
          React.createElement('div', { key: 'ctrl', className: 'xmly-bar-ctrl' }, [
            React.createElement('button', { key: 'prev', className: 'xmly-bar-btn', title: '上一集', onClick: () => { unlockAutoplay(); void step(-1); } }, '⏮'),
            React.createElement('button', {
              key: 'rew', className: 'xmly-bar-btn', title: '快退 ' + s.seekStep + ' 秒（右键改步长）',
              onClick: () => seekBy(-s.seekStep),
              onContextMenu: (ev) => { ev.preventDefault(); setPop(pop === 'step' ? '' : 'step'); },
            }, '⏪\uFE0E'),
            React.createElement('button', { key: 'play', className: 'xmly-bar-btn xmly-bar-play', title: s.playing ? '暂停' : '播放', onClick: togglePlayPause },
              s.buffering ? '⋯' : (s.playing ? '⏸' : '▶')),
            React.createElement('button', {
              key: 'ff', className: 'xmly-bar-btn', title: '快进 ' + s.seekStep + ' 秒（右键改步长）',
              onClick: () => seekBy(s.seekStep),
              onContextMenu: (ev) => { ev.preventDefault(); setPop(pop === 'step' ? '' : 'step'); },
            }, '⏩\uFE0E'),
            React.createElement('button', { key: 'next', className: 'xmly-bar-btn', title: '下一集', onClick: () => { unlockAutoplay(); void step(1); } }, '⏭'),
          ]),
          React.createElement('div', { key: 'meta', className: 'xmly-bar-meta' }, [
            React.createElement('span', { key: 'time', className: 'xmly-bar-time' }, fmtTime(s.position) + (dur > 0 ? ' / ' + fmtTime(dur) : '')),
            React.createElement('button', {
              key: 'vol', className: 'xmly-bar-btn', title: s.volume > 0 ? '静音' : '取消静音',
              onClick: () => {
                if (audio.volume > 0) {
                  volBeforeMute = audio.volume;      // 保存静音前的值
                  audio.volume = 0;
                  set({ volume: 0 });
                } else {
                  const target = volBeforeMute > 0 ? volBeforeMute : 0.9;  // 用保存值恢复，无可用值时兜底 0.9
                  audio.volume = target;
                  set({ volume: target });
                }
                persistPlayback();
              },
            }, s.volume > 0 ? '🔊' : '🔇'),
            // 音量滑动条常显：内联在音量按钮右侧、占满中间空白，把倍速/搜索推到行右
            React.createElement(VolumePopup, { key: 'volrow' }),
            React.createElement('button', {
              key: 'rate', className: 'xmly-bar-btn' + (s.rate !== 1 ? ' active' : ''), title: '倍速',
              onClick: () => { const i = RATES.indexOf(s.rate); const r = RATES[(i + 1) % RATES.length] || 1; audio.playbackRate = r; set({ rate: r }); persistPlayback(); },
            }, s.rate + 'x'),
            React.createElement('button', {
              key: 'panel', className: 'xmly-bar-btn', title: '搜索/列表',
              onClick: () => {
                const open = !s.panelOpen;
                // 打开时若停在"空专辑页"（album 已被清空），回到搜索页避免白屏。
                const patch = { panelOpen: open };
                if (open && store.tab === 'album' && store.album === null) patch.tab = 'search';
                set(patch);
                persistPanel();
              },
            }, '🔎'),
          ]),
          pop === 'step' ? React.createElement(StepPopup, { key: 'steppop' }) : null,
          React.createElement(ProgressBar, { key: 'pb', compact: true }),
        ]),
        s.toast ? React.createElement('div', { key: 'toast', className: 'xmly-toast' + (s.toast.ok ? '' : ' xmly-toast-bad') }, s.toast.text) : null,
      );
    }

    // ------------------------------------------------------------------
    // UI: 面板
    // ------------------------------------------------------------------
    const PANEL_W = 460;
    function useDragPanel(headerRef) {
      const dragging = useRef(null);
      useEffect(() => {
        const onMove = (ev) => {
          if (dragging.current === null) return;
          const d = dragging.current;
          // 钳制：面板不得拖进底部输入区（会盖住播放条按钮）。
          set({ panelPos: clampPanelPos({ x: ev.clientX - d.dx, y: ev.clientY - d.dy }) });
        };
        const onUp = () => {
          if (dragging.current !== null) {
            dragging.current = null;
            persistPanel();
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      }, []);
      const onDown = (ev) => {
        if (!headerRef.current) return;
        // 头部按钮（播放/暂停、收起）不触发拖拽。
        if (ev.target && ev.target.closest && ev.target.closest('button')) return;
        const pos = store.panelPos || { x: Math.max(16, (window.innerWidth - PANEL_W) / 2), y: 80 };
        dragging.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y };
        set({ panelPos: pos });
      };
      return onDown;
    }

    function SearchTab() {
      const s = useStore();
      const [kw, setKw] = useState(s.searchKw || '');
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      // 热搜词（喜马拉雅匿名接口）：进搜索页拉一次，点 chip 直接搜。
      useEffect(() => {
        if (supports('hotWords') && s.hots.length === 0 && !s.hotsLoaded) void loadHots();
      }, [s.platform, s.hotsLoaded]);
      // 分类榜单：展开时拉分类树，选中即拉内容。
      useEffect(() => {
        if (s.showRanks && supports('ranks') && !s.rankCatsLoaded) void loadRankCats();
      }, [s.showRanks, s.platform, s.rankCatsLoaded]);
      const toggleRanks = () => set(s.showRanks ? { showRanks: false } : { showRanks: true });
      // 榜单入口按钮 + 榜单面板（抽成两个局部，懒人未登录时也能浏览榜单——榜单接口匿名可用）。
      const rankToggleBtn = supports('ranks')
        ? React.createElement('button', {
            key: 'r', className: 'xmly-btn' + (s.showRanks ? ' xmly-btn-subbed' : ''),
            title: '分类榜单：选择分类后显示榜单内容',
            onClick: toggleRanks,
          }, s.showRanks ? '收起榜单' : '📈 榜单')
        : null;
      const rankBoard = (() => {
        if (!s.showRanks || !supports('ranks')) return null;
        const curTab = (s.rankCats || []).find((t) => t.id === s.rankCat1) || (s.rankCats || [])[0] || null;
        const curWraps = curTab ? (curTab.wraps || []) : [];
        const hasTwoLevel = (s.rankCats || []).length > 1 || (curTab && (curTab.wraps || []).length > 1);
        return React.createElement('div', { key: 'ranks', className: 'xmly-ranks' }, [
          React.createElement('div', { key: 'cats', className: 'xmly-rank-cats' }, [
            hasTwoLevel && curTab
              ? React.createElement('select', {
                  key: 'sel1', className: 'xmly-select', value: String(curTab.id),
                  onChange: (ev) => {
                    const id = Number(ev.target.value);
                    const tab = (s.rankCats || []).find((t) => t.id === id);
                    const firstWrap = tab && tab.wraps[0];
                    set({ rankCat1: id, rankCat2: firstWrap ? firstWrap.rankingId : null });
                    if (firstWrap) void loadRankContent(firstWrap.rankingId);
                  },
                },
                (s.rankCats || []).map((t) => React.createElement('option', { key: 'o' + t.id, value: String(t.id) }, t.name)))
              : null,
            curWraps.length > 0
              ? React.createElement('select', {
                  key: 'sel2', className: 'xmly-select', value: String(s.rankCat2 || ''),
                  onChange: (ev) => {
                    const id = Number(ev.target.value);
                    set({ rankCat2: id });
                    void loadRankContent(id);
                  },
                },
                curWraps.map((w) => React.createElement('option', { key: 'w' + w.rankingId, value: String(w.rankingId) }, w.name)))
              : null,
          ]),
          s.rankContentLoading
            ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '榜单加载中…')
            : null,
          s.rankContent && s.rankContent.title
            ? React.createElement('div', { key: 'board', className: 'xmly-rank-board' }, [
                React.createElement('div', { key: 'h', className: 'xmly-rank-title' }, [
                  React.createElement('span', { key: 't', className: 'xmly-rank-name' }, s.rankContent.title),
                  React.createElement('span', { key: 'n', className: 'xmly-muted' },
                    ' · ' + (s.rankContent.albums ? s.rankContent.albums.length : 0) + ' 部'),
                ]),
                React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                  (s.rankContent.albums || []).map((a, i) => React.createElement('div', {
                    key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
                  }, [
                    a.cover
                      ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' })
                      : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                    React.createElement('span', { key: 'no', className: 'xmly-rank-no' + (i < 3 ? ' top' : '') }, (i + 1)),
                    React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                      React.createElement('div', { key: 't', className: 'xmly-album-title', title: a.title },
                        a.title,
                        a.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null),
                      React.createElement('div', { key: 'a', className: 'xmly-muted' },
                        (a.anchorName || '') + (a.category ? ' · ' + a.category : '')),
                      React.createElement('div', { key: 's', className: 'xmly-muted xmly-album-stat' }, [
                        React.createElement('span', { key: 'n' }, a.trackCount + ' 集'),
                        React.createElement('span', { key: 'f' }, fmtCount(a.playCount) + ' 次播放'),
                      ]),
                    ]),
                  ]))),
              ])
            : null,
        ]);
      })();
      // 懒人听书的搜索接口对匿名请求返回 485：没登录就别给输入框，直接引导登录。
      const platMeta = metaOf(s.platform);
      const gated = needsLoginFor('search', s.platform, s.loggedIn);
      if (gated) {
        return React.createElement('div', { className: 'xmly-tab-body' }, [
          React.createElement('div', { key: 'g', className: 'xmly-gate' }, [
            React.createElement('div', { key: 't', className: 'xmly-gate-title' }, '🔒 ' + (platMeta.label || '该平台') + '需要登录'),
            React.createElement('div', { key: 'd', className: 'xmly-muted' },
              '它的搜索与收听接口都要求登录态（连免费章节也一样）。用手机 App 扫码登录后即可搜索并收听，会员内容需要账号本身有会员/已购权限。'),
            React.createElement('button', {
              key: 'b', className: 'xmly-btn xmly-btn-primary',
              onClick: () => set({ tab: 'mine', panelOpen: true }),
            }, '去扫码登录'),
          ]),
          rankToggleBtn,
          rankBoard,
        ]);
      }
      const placeholder = s.platform === 'lrts'
        ? '搜书名 / 作者 / 播讲人（如：三体、单田芳、史上第一混乱）'
        : '搜专辑 / 播客 / 有声书（如：三体、郭德纲、晓说）';
      return React.createElement('div', { className: 'xmly-tab-body xmly-search-body' }, [
        React.createElement('div', { key: 'input', className: 'xmly-search-row' }, [
          React.createElement('input', {
            key: 'i', ref: inputRef, className: 'xmly-input', placeholder,
            value: kw, onChange: (ev) => setKw(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') { void doSearch(kw, 1); set({ panelOpen: true }); } },
          }),
          React.createElement('button', {
            key: 'b', className: 'xmly-btn xmly-btn-primary', disabled: s.searching,
            onClick: () => void doSearch(kw, 1),
          }, s.searching ? '搜索中…' : '搜索'),
          rankToggleBtn,
        ]),
        rankBoard,
        s.hots.length > 0 && s.searchResults.length === 0 && !s.searching
          ? React.createElement('div', { key: 'hots', className: 'xmly-history' }, [
              React.createElement('span', { key: 'label', className: 'xmly-muted' }, '🔥 大家都在搜：'),
              ...s.hots.slice(0, 10).map((h) =>
                React.createElement('button', {
                  key: 'hot-' + h, className: 'xmly-chip', onClick: () => { setKw(h); void doSearch(h, 1); },
                }, h)),
            ])
          : null,
        s.history.length > 0 && s.searchResults.length === 0 && !s.searching
          ? React.createElement('div', { key: 'hist', className: 'xmly-history' }, [
              React.createElement('span', { key: 'label', className: 'xmly-muted' }, '最近搜索：'),
              ...s.history.slice(0, 8).map((h) =>
                React.createElement('button', {
                  key: 'h-' + h, className: 'xmly-chip', onClick: () => { setKw(h); void doSearch(h, 1); },
                }, h)),
            ])
          : null,
        s.searchError ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.searchError) : null,
        React.createElement('div', { key: 'list', className: 'xmly-album-list' },
          s.searchResults.length === 0 && !s.searching && !s.searchError
            ? React.createElement('div', { key: 'empty', className: 'xmly-empty' }, '输入关键词开始搜索' + platformLabel() + '内容')
            : s.searchResults.map((a) => React.createElement('div', {
                key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
              }, [
                a.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                  React.createElement('div', { key: 't', className: 'xmly-album-title', title: a.title },
                    a.title,
                    a.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null,
                  ),
                  React.createElement('div', { key: 'a', className: 'xmly-muted' }, (a.anchorName || '') + ' · ' + (a.category || '')),
                  React.createElement('div', { key: 'i', className: 'xmly-album-intro xmly-muted', title: a.intro }, a.intro || ''),
                  React.createElement('div', { key: 's', className: 'xmly-muted xmly-album-stat' }, [
                    React.createElement('span', { key: 'n' }, a.trackCount + ' 集'),
                    React.createElement('span', { key: 'f' }, a.isFinished ? '完结' : '连载'),
                    React.createElement('span', { key: 'p' }, fmtCount(a.playCount) + ' 次播放'),
                  ]),
                ]),
              ])),
        ),
        !s.searchDone && s.searchResults.length > 0
          ? React.createElement('button', {
              key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.searching,
              onClick: () => void doSearch(s.searchKw, s.searchPage + 1),
            }, s.searching ? '加载中…' : '加载更多（' + fmtCount(s.searchTotal) + ' 个结果）')
          : (s.searchDone && s.searchResults.length > 0
              ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共 ' + fmtCount(s.searchTotal) + ' 个结果，已全部加载')
              : null),
      ]);
    }

    function AlbumTab() {
      const s = useStore();
      // 滚动到底部自动加载下一批 30 集：面板滚动容器里放一个哨兵节点，
      // IntersectionObserver 命中就拉下一页（不再需要手点「加载更多」）。
      const sentinelRef = useRef(null);
      const hasMore = s.album !== null && s.albumPageId < s.albumMaxPageId;
      useEffect(() => {
        const el = sentinelRef.current;
        if (el === null || !hasMore || s.albumMore || s.albumLoading) return undefined;
        if (typeof IntersectionObserver !== 'function') return undefined;
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) { io.disconnect(); void loadMoreTracks(); }
          }
        }, { rootMargin: '160px 0px' });
        io.observe(el);
        return () => io.disconnect();
      }, [hasMore, s.albumMore, s.albumLoading, s.albumPageId, s.albumMaxPageId, s.album && s.album.id]);
      if (s.albumLoading) return React.createElement('div', { className: 'xmly-tab-body' }, React.createElement('div', { className: 'xmly-empty' }, '专辑加载中…'));
      if (s.albumError) return React.createElement('div', { className: 'xmly-tab-body' }, [
        React.createElement('div', { key: 'e', className: 'xmly-error-text' }, s.albumError),
        React.createElement('button', { key: 'b', className: 'xmly-btn', onClick: () => set({ tab: 'search' }) }, '返回搜索'),
      ]);
      if (s.album === null) return React.createElement('div', { className: 'xmly-tab-body' }, [
        React.createElement('div', { key: 'e', className: 'xmly-empty' }, '还没有选择专辑'),
        React.createElement('button', { key: 'b', className: 'xmly-btn', onClick: () => set({ tab: 'search' }) }, '去搜索'),
      ]);
      const a = s.album;
      const favActive = s.favs.some((f) => f.id === a.id);
      return React.createElement('div', { className: 'xmly-tab-body xmly-album-body' }, [
        React.createElement('div', { key: 'head', className: 'xmly-album-head' }, [
          a.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover-lg', src: a.cover, alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover-lg xmly-album-cover-ph' }, '🎧'),
          React.createElement('div', { key: 'm', className: 'xmly-album-head-meta' }, [
            React.createElement('div', { key: 't', className: 'xmly-album-title-lg', title: a.title }, a.title),
            React.createElement('div', { key: 'a', className: 'xmly-muted' }, (a.anchorName || '') + (a.category ? ' · ' + a.category : '')),
            React.createElement('div', { key: 's', className: 'xmly-muted' }, (a.isFinished ? '完结' : '连载') + ' · ' + s.albumTotal + ' 集' + (a.isPaid ? ' · 含付费内容' : '')),
            React.createElement('div', { key: 'ops', className: 'xmly-album-ops' }, [
              s.albumTracks.length > 0
                ? React.createElement('button', {
                    key: 'play', className: 'xmly-btn xmly-btn-primary',
                    onClick: () => void playTrack(s.albumTracks[0], { id: a.id, title: a.title }),
                  }, '▶ 播放')
                : null,
              s.loggedIn
                ? React.createElement('button', {
                    key: 'sub', className: 'xmly-btn' + (s.cloudSubs[a.id] ? ' xmly-btn-subbed' : ''),
                    title: '云端订阅（手机 App「订阅」同步可见）',
                    onClick: () => void toggleSubscribe(a, s.albumTotal),
                  }, s.cloudSubs[a.id] ? '📻 已订阅' : '📻 订阅')
                : null,
              React.createElement('button', {
                key: 'fav', className: 'xmly-btn' + (favActive ? ' xmly-btn-fav' : ''),
                onClick: () => void toggleFav({ id: a.id, title: a.title, cover: a.cover, anchorName: a.anchorName, trackCount: s.albumTotal, category: a.category, isPaid: a.isPaid }),
              }, favActive ? '♥ 已收藏' : '♡ 收藏'),
            ]),
          ]),
        ]),
        a.intro ? React.createElement('div', { key: 'intro', className: 'xmly-album-intro-full xmly-muted', title: a.intro }, a.intro) : null,
        React.createElement('div', { key: 'list', className: 'xmly-track-list' },
          s.albumTracks.map((t, i) => {
            const active = s.current && s.current.trackId === t.id;
            return React.createElement('div', {
              key: t.id, className: 'xmly-track-row' + (active ? ' active' : ''), onClick: () => void playTrack(t, { id: a.id, title: a.title }),
            }, [
              React.createElement('span', { key: 'i', className: 'xmly-track-idx' }, active && s.playing ? '♪' : (i + 1)),
              React.createElement('span', { key: 't', className: 'xmly-track-title', title: t.title }, t.title),
              t.isPaid && !t.isFree ? React.createElement('span', { key: 'v', className: 'xmly-badge xmly-badge-vip' }, t.isAuthorized ? '可播' : 'VIP') : null,
              React.createElement('span', { key: 'd', className: 'xmly-track-dur xmly-muted' }, fmtTime(t.duration)),
            ]);
          })),
        s.albumTracks.length === 0 ? React.createElement('div', { key: 'empty', className: 'xmly-empty' }, '该专辑暂无曲目') : null,
        s.albumTruncated
          ? React.createElement('div', { key: 'trunc', className: 'xmly-empty xmly-empty-thin' },
              '该专辑目录超过 1000 章，仅前 1000 章可浏览/收听（对端接口限制）')
          : null,
        // 自动加载哨兵：进入可视区即拉下一页；同时保留手点按钮作兜底（IO 不可用时）。
        hasMore ? React.createElement('div', { key: 'sentinel', ref: sentinelRef, className: 'xmly-load-sentinel' },
          s.albumMore ? '正在加载第 ' + (s.albumPageId + 1) + ' / ' + s.albumMaxPageId + ' 页…' : '滚动到底部自动加载下一批 30 集') : null,
        hasMore
          ? React.createElement('button', {
              key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.albumMore,
              onClick: () => void loadMoreTracks(),
            }, s.albumMore ? '加载中…' : '加载更多（已加载 ' + s.albumTracks.length + ' / ' + s.albumTotal + ' 集）')
          : (s.albumTotal > 0 && s.albumTracks.length >= s.albumTotal
              ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '已加载全部 ' + s.albumTotal + ' 集')
              : null),
      ]);
    }

    function MineTab() {
      const s = useStore();
      // 懒人听书只有「本地收藏的专辑」这一块（收藏声音/订阅/关注都是喜马拉雅接口）。
      const isXmly = s.platform === 'ximalaya';
      useEffect(() => {
        if (!s.loggedIn && s.qr === null && s.qrStatus !== 'loading' && s.qrStatus !== 'expired') {
          void startQrLogin();
        }
      }, [s.loggedIn, s.platform]);
      useEffect(() => {
        if (!s.loggedIn && s.qr !== null) {
          const t = setInterval(() => { void pollQr(); }, 2500);
          return () => clearInterval(t);
        }
      }, [s.loggedIn, s.qr && (s.qr.qrId || s.qr.sceneToken)]);
      // 登录信息（会员标识/剩余天数）每次进入「我的」都拉一次最新值。
      useEffect(() => { void loadUser(); }, [s.loggedIn, s.platform]);
      // 按当前分段懒加载（翻段/登录成功/切平台都会触发）。
      useEffect(() => {
        if (s.mineSeg === 'recent') { void loadListens(); return; }
        if (!s.loggedIn) return;
        if (s.mineSeg === 'cloudfavs' && !isXmly) { void loadCloudFavs(false); return; }
        if (!isXmly) return;
        if (s.mineSeg === 'likes' && !s.likesLoaded && !s.likes.loading) void loadLikes(1);
        if (s.mineSeg === 'subs' && !s.subsLoaded && !s.subs.loading) void loadSubs(1);
        if (s.mineSeg === 'anchors' && !s.followingLoaded && !s.following.loading) void loadFollowing(1);
      }, [s.loggedIn, s.mineSeg, s.platform]);

      // 手动刷新当前分段（云端历史/收藏都是外部状态，必须能一键拉新）。
      const refreshMine = () => {
        void loadUser();
        if (s.mineSeg === 'recent') { void loadListens(false, true); return; }
        if (!isXmly) {
          if (s.mineSeg === 'cloudfavs') void loadCloudFavs(true);
          return;
        }
        if (s.mineSeg === 'likes') void loadLikes(1);
        if (s.mineSeg === 'subs') void loadSubs(1);
        if (s.mineSeg === 'anchors') void loadFollowing(1);
        // albums（本地收藏）存本机，刷新 manifest 即重新水合。
        if (s.mineSeg === 'albums') void loadManifest();
      };
      const refreshing = s.listensLoading || s.cloudFavsLoading || s.likes.loading || s.subs.loading || s.following.loading;
      const segBtn = (id, label) => React.createElement('button', {
        key: id, className: 'xmly-seg-btn' + (s.mineSeg === id ? ' active' : ''),
        onClick: () => set({ mineSeg: id }),
      }, label);

      const loginHint = (what) => React.createElement('div', { className: 'xmly-empty xmly-empty-thin' },
        '扫码登录后即可查看' + what);

      // 分段内容
      let segBody = null;
      if (s.mineSeg === 'recent') {
        // 收听历史：直接读账号云端那份（喜马拉雅「听过」/ 懒人听书「收听记录」），
        // 所以手机端刚听完一集，这里点「刷新」就能看到并接着听。
        segBody = !s.loggedIn
          ? loginHint('收听历史')
          : React.createElement('div', { key: 'recent' }, [
              React.createElement('div', { key: 'bar', className: 'xmly-mine-subbar' }, [
                React.createElement('span', { key: 'c', className: 'xmly-muted' },
                  s.listensTotal > 0
                    ? '共 ' + s.listensTotal + ' 条（' + platformLabel() + ' 账号云端记录）'
                    : platformLabel() + ' 账号云端收听记录'),
              ]),
              s.listensLoading && s.listens.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.listensLoading && s.listens.length === 0
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' },
                    '账号里还没有收听记录：在' + platformLabel() + '手机端或网页端点开一集，点「刷新」就会同步过来')
                : React.createElement('div', { key: 'list', className: 'xmly-like-list' },
                    s.listens.map((r) => {
                      const active = s.current && s.current.trackId === r.trackId;
                      const pct = r.duration > 0 ? Math.min(100, Math.round((r.position / r.duration) * 100)) : 0;
                      return React.createElement('div', {
                        key: String(r.albumId) + ':' + String(r.trackId),
                        className: 'xmly-like-row' + (active ? ' active' : ''),
                        title: '继续收听：' + (r.trackTitle || ''),
                        onClick: () => void playTrack(
                          { id: r.trackId, title: r.trackTitle, section: r.section, cover: r.cover, albumId: r.albumId, duration: r.duration },
                          r.albumId ? { id: r.albumId, title: r.albumTitle } : null,
                          { position: r.position || 0 },
                        ),
                      }, [
                        r.cover
                          ? React.createElement('img', { key: 'c', className: 'xmly-like-cover', src: r.cover, loading: 'lazy', alt: '' })
                          : React.createElement('div', { key: 'c', className: 'xmly-like-cover xmly-album-cover-ph' }, '🎧'),
                        React.createElement('div', { key: 'm', className: 'xmly-like-meta' }, [
                          React.createElement('div', { key: 't', className: 'xmly-like-title' },
                            React.createElement('span', { key: 'n', className: 'xmly-like-title-text' }, r.trackTitle || ('曲目 #' + r.trackId))),
                          React.createElement('div', { key: 'a', className: 'xmly-muted xmly-like-sub' }, r.albumTitle || '未知专辑'),
                          React.createElement('div', { key: 's', className: 'xmly-muted xmly-like-sub' },
                            '听到 ' + fmtTime(r.position || 0)
                            + (r.duration > 0 ? ' / ' + fmtTime(r.duration) + '（' + pct + '%）' : '')
                            + (r.updatedText ? ' · ' + r.updatedText : '')),
                        ]),
                        React.createElement('span', { key: 'p', className: 'xmly-like-play' }, active && s.playing ? '♪' : '▶'),
                      ]);
                    })),
              s.listensHasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-sm xmly-btn-ghost xmly-more-btn',
                    disabled: s.listensLoading,
                    onClick: () => void loadListens(true),
                  }, s.listensLoading ? '加载中…' : '加载更多')
                : null,
        ]);
      } else if (isXmly && s.mineSeg === 'likes') {
        segBody = !s.loggedIn
          ? loginHint('收藏的声音')
          : React.createElement('div', { key: 'likes' }, [
              s.likes.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.likes.error) : null,
              s.likes.loading && s.likes.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.likes.loading && s.likes.list.length === 0 && !s.likes.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有收藏的声音：在播放页/声音页点 ♥ 即可收藏')
                : React.createElement('div', { key: 'list', className: 'xmly-like-list' },
                    s.likes.list.map((t) => {
                      const active = s.current && s.current.trackId === t.id;
                      return React.createElement('div', {
                        key: t.id, className: 'xmly-like-row' + (active ? ' active' : ''),
                        onClick: () => void playTrack(t, t.albumId ? { id: t.albumId, title: t.albumTitle } : null),
                        title: '点击播放：' + t.title,
                      }, [
                        t.cover
                          ? React.createElement('img', { key: 'c', className: 'xmly-like-cover', src: t.cover, loading: 'lazy', alt: '' })
                          : React.createElement('div', { key: 'c', className: 'xmly-like-cover xmly-album-cover-ph' }, '🎵'),
                        React.createElement('div', { key: 'm', className: 'xmly-like-meta' }, [
                          React.createElement('div', { key: 't', className: 'xmly-like-title' }, [
                            React.createElement('span', { key: 'n', className: 'xmly-like-title-text' }, t.title),
                            t.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null,
                            t.isVideo ? React.createElement('span', { key: 'v', className: 'xmly-badge' }, '视频') : null,
                          ]),
                          React.createElement('div', { key: 'a', className: 'xmly-muted xmly-like-sub' },
                            (t.albumTitle || '未知专辑') + ' · ' + (t.anchorName || '')),
                          React.createElement('div', { key: 's', className: 'xmly-muted xmly-like-sub' },
                            (t.durationText || fmtTime(t.duration)) + (t.playCount ? ' · ' + fmtCount(t.playCount) + ' 次播放' : '') + (t.createdAtText ? ' · ' + t.createdAtText : '')),
                        ]),
                        React.createElement('span', { key: 'p', className: 'xmly-like-play' }, active && s.playing ? '♪' : '▶'),
                        React.createElement('button', {
                          key: 'x', className: 'xmly-bar-btn xmly-cloud-op', title: '取消收藏（云端同步，手机同步移除）',
                          onClick: (ev) => { ev.stopPropagation(); void unlikeTrack(t); },
                        }, '✕'),
                      ]);
                    })),
              s.likes.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.likes.loading,
                    onClick: () => void loadLikes(s.likes.pageNum + 1),
                  }, s.likes.loading ? '加载中…' : '加载更多（共 ' + s.likes.total + ' 条）')
                : (s.likes.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共收藏 ' + s.likes.total + ' 条声音')
                    : null),
            ]);
      } else if (isXmly && s.mineSeg === 'subs') {
        segBody = !s.loggedIn
          ? loginHint('订阅的专辑')
          : React.createElement('div', { key: 'subs' }, [
              s.subs.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.subs.error) : null,
              s.subs.loading && s.subs.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.subs.loading && s.subs.list.length === 0 && !s.subs.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有订阅专辑：在专辑页点「订阅」即可')
                : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                    s.subs.list.map((a) => React.createElement('div', {
                      key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
                      title: '打开专辑：' + a.title,
                    }, [
                      a.cover
                        ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' })
                        : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                      React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                        React.createElement('div', { key: 't', className: 'xmly-album-title' },
                          a.title,
                          a.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null),
                        React.createElement('div', { key: 'a', className: 'xmly-muted' },
                          (a.anchorName || '') + (a.category ? ' · ' + a.category : '') + ' · ' + a.trackCount + ' 集' + (a.isFinished ? ' · 完结' : '')),
                        a.lastTrackTitle
                          ? React.createElement('div', { key: 'u', className: 'xmly-muted xmly-like-sub', title: a.lastTrackTitle },
                              '最新：' + (a.lastUpdateText ? a.lastUpdateText + ' · ' : '') + a.lastTrackTitle)
                          : null,
                      ]),
                      React.createElement('button', {
                        key: 'x', className: 'xmly-bar-btn xmly-cloud-op', title: '退订（云端同步，手机同步移除）',
                        onClick: (ev) => { ev.stopPropagation(); void toggleSubscribe(a, a.trackCount); },
                      }, '退订'),
                    ]))),
              s.subs.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.subs.loading,
                    onClick: () => void loadSubs(s.subs.page + 1),
                  }, s.subs.loading ? '加载中…' : '加载更多（共 ' + s.subs.total + ' 张）')
                : (s.subs.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共订阅 ' + s.subs.total + ' 张专辑')
                    : null),
            ]);
      } else if (isXmly && s.mineSeg === 'anchors') {
        segBody = !s.loggedIn
          ? loginHint('已关注的主播')
          : React.createElement('div', { key: 'anchors' }, [
              s.following.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.following.error) : null,
              s.following.loading && s.following.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.following.loading && s.following.list.length === 0 && !s.following.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有关注任何主播：去主播页点「+ 关注」')
                : React.createElement('div', { key: 'list', className: 'xmly-anchor-list' },
                    s.following.list.map((a) => React.createElement('div', {
                      key: a.uid, className: 'xmly-anchor-card', onClick: () => void openAnchor(a),
                      title: '查看「' + a.nickname + '」的专辑',
                    }, [
                      a.cover
                        ? React.createElement('img', { key: 'c', className: 'xmly-anchor-avatar', src: a.cover, loading: 'lazy', alt: '' })
                        : React.createElement('div', { key: 'c', className: 'xmly-anchor-avatar xmly-album-cover-ph' }, (a.nickname || '主').slice(0, 1)),
                      React.createElement('div', { key: 'm', className: 'xmly-anchor-meta' }, [
                        React.createElement('div', { key: 'n', className: 'xmly-anchor-name' }, a.nickname || ('主播 #' + a.uid)),
                        React.createElement('div', { key: 'd', className: 'xmly-muted xmly-like-sub', title: a.description || a.ptitle }, a.description || a.ptitle || ''),
                        React.createElement('div', { key: 's', className: 'xmly-muted xmly-like-sub' },
                          fmtCount(a.fansCount) + ' 粉丝 · ' + a.albumCount + ' 专辑 · ' + fmtCount(a.trackCount) + ' 声音'),
                      ]),
                      React.createElement('span', { key: 'go', className: 'xmly-anchor-go' }, '›'),
                      React.createElement('button', {
                        key: 'x', className: 'xmly-bar-btn xmly-cloud-op', title: '取消关注（云端同步，手机同步移除）',
                        onClick: (ev) => { ev.stopPropagation(); void unfollowAnchor(a); },
                      }, '取关'),
                    ]))),
              s.following.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.following.loading,
                    onClick: () => void loadFollowing(s.following.page + 1),
                  }, s.following.loading ? '加载中…' : '加载更多（共 ' + s.following.total + ' 位）')
                : (s.following.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共关注 ' + s.following.total + ' 位主播')
                    : null),
            ]);
      } else if (!isXmly && s.mineSeg === 'cloudfavs') {
        // 懒人听书云端收藏（POST /api/collection/getCollectionBooks）：登录后一次取回全部，
        // 是外部状态 —— 在 App/网页端新点收藏后必须点「刷新」才会出现在这里。
        segBody = !s.loggedIn
          ? loginHint('懒人听书收藏')
          : React.createElement('div', { key: 'cloudfavs' }, [
              s.cloudFavsError ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.cloudFavsError) : null,
              s.cloudFavsLoading && s.cloudFavs.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.cloudFavsLoading && s.cloudFavs.length === 0 && !s.cloudFavsError
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' },
                    '还没有收藏的书籍：在懒人听书里点收藏，然后点上方「刷新」')
                : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                    s.cloudFavs.map((a) => React.createElement('div', {
                      key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
                      title: '打开书籍：' + a.title,
                    }, [
                      a.cover
                        ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' })
                        : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '📚'),
                      React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                        React.createElement('div', { key: 't', className: 'xmly-album-title' }, a.title || ('书籍 #' + a.id)),
                        React.createElement('div', { key: 'a', className: 'xmly-muted' },
                          (a.anchorName || '') + (a.trackCount > 0 ? ' · ' + a.trackCount + ' 集' : '')),
                      ]),
                    ]))),
              s.cloudFavs.length > 0
                ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' },
                    '共 ' + s.cloudFavs.length + ' 本（来自懒人听书账号，点「刷新」拉取最新）')
                : null,
            ]);
      } else if (isXmly && s.mineSeg === 'albums') {
        // 本地收藏的专辑（存 Host 状态文件，仅喜马拉雅暴露此分段——
        // 懒人听书有真正的云端收藏「★ 收藏」，本地的没有跨设备价值）。
        segBody = React.createElement('div', { key: 'albums' }, [
          s.favs.length === 0
            ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '在专辑详情里点「♡ 收藏」添加')
            : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                s.favs.map((f) => React.createElement('div', { key: f.id, className: 'xmly-album-card', onClick: () => void openAlbum(f.id) }, [
                  f.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: f.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                  React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                    React.createElement('div', { key: 't', className: 'xmly-album-title' }, f.title),
                    React.createElement('div', { key: 'a', className: 'xmly-muted' }, (f.anchorName || '') + ' · ' + (f.trackCount || 0) + ' 集'),
                  ]),
                  React.createElement('button', {
                    key: 'x', className: 'xmly-bar-btn', title: '取消收藏',
                    onClick: (ev) => { ev.stopPropagation(); void toggleFav(f); },
                  }, '✕'),
                ]))),
        ]);
      }

      return React.createElement('div', { className: 'xmly-tab-body xmly-mine-body' }, [
        React.createElement('div', { key: 'login', className: 'xmly-login-box' },
          s.loggedIn
            ? React.createElement('div', { key: 'u', className: 'xmly-user-row' }, [
                s.user && s.user.avatar
                  ? React.createElement('img', { key: 'a', className: 'xmly-avatar', src: s.user.avatar, alt: '' })
                  : React.createElement('span', { key: 'a', className: 'xmly-avatar' }, (s.user && s.user.nickname ? s.user.nickname.slice(0, 1) : platformLabel().slice(0, 1))),
                React.createElement('div', { key: 'm', className: 'xmly-user-meta' }, [
                  React.createElement('div', { key: 'n', className: 'xmly-user-name' }, (s.user && s.user.nickname) || '已登录',
                    s.user && s.user.isVip ? React.createElement('span', { key: 'v', className: 'xmly-badge xmly-badge-vip' }, vipBadge(s.user)) : null),
                  React.createElement('div', { key: 'd', className: 'xmly-muted' },
                    platformLabel() + ' · ' + vipLine(s.user)),
                ]),
                React.createElement('button', {
                  key: 'out', className: 'xmly-btn xmly-btn-ghost',
                  onClick: async () => {
                    await apiPost('/dsh-tingbar/logout', {});
                    set({
                      loggedIn: false, user: null,
                      likes: { list: [], total: 0, pageNum: 1, hasMore: false, loading: false, error: '' }, likesLoaded: false,
                      subs: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, subsLoaded: false,
                      following: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, followingLoaded: false,
                      cloudSubs: {},
                    });
                    showToast('已退出登录');
                    void loadManifest();
                  },
                }, '退出'),
              ])
            : React.createElement('div', { key: 'q', className: 'xmly-qr-box' }, [
                s.qr !== null
                  ? React.createElement('img', { key: 'img', className: 'xmly-qr-img', src: s.qr.imageDataUrl, alt: '登录二维码' })
                  : React.createElement('div', { key: 'ph', className: 'xmly-qr-img xmly-qr-ph' }, s.qrStatus === 'loading' ? '生成中…' : '已过期'),
                React.createElement('div', { key: 'hint', className: 'xmly-muted' }, [
                  '打开' + platformLabel() + ' App 扫码登录，解锁 VIP / 已购内容',
                  s.qr && s.qr.hint ? React.createElement('div', { key: 'h', className: 'xmly-qr-status' }, s.qr.hint) : null,
                  React.createElement('div', { key: 'st', className: 'xmly-qr-status' },
                    s.qrStatus === 'expired' ? '二维码已过期，' : (s.qrStatus === 'waiting' ? '等待扫码… ' : '')),
                  s.qrStatus === 'expired'
                    ? React.createElement('button', { key: 'r', className: 'xmly-btn xmly-btn-sm', onClick: () => void startQrLogin() }, '刷新二维码')
                    : null,
                ]),
              ]),
        ),
        React.createElement('div', { key: 'segrow', className: 'xmly-seg-row-wrap' }, [
          React.createElement('div', { key: 'seg', className: 'xmly-seg-row' },
            isXmly
              ? [
                  segBtn('recent', '🕘 历史'),
                  segBtn('likes', '♥ 声音'),
                  segBtn('subs', '📻 订阅'),
                  segBtn('anchors', '👤 主播'),
                  segBtn('albums', '★ 专辑'),
                ]
              : [
                  segBtn('recent', '🕘 历史'),
                  segBtn('cloudfavs', '★ 收藏'),
                ]),
          React.createElement('button', {
            key: 'refresh',
            className: 'xmly-btn xmly-btn-sm xmly-btn-ghost xmly-mine-refresh',
            title: '刷新当前列表（收藏/历史都在对端或本机别处变化，需要手动拉新）',
            disabled: refreshing,
            onClick: refreshMine,
          }, refreshing ? '刷新中…' : '↻ 刷新'),
        ]),
        segBody,
      ]);
    }

    function AnchorTab() {
      const s = useStore();
      const a = s.anchorView;
      if (a === null) return React.createElement('div', { className: 'xmly-tab-body' },
        React.createElement('div', { className: 'xmly-empty' }, '还没有选择主播，去「我的 → 关注的主播」看看'));
      return React.createElement('div', { className: 'xmly-tab-body xmly-anchor-body' }, [
        React.createElement('div', { key: 'head', className: 'xmly-anchor-head' }, [
          a.cover
            ? React.createElement('img', { key: 'c', className: 'xmly-anchor-avatar-lg', src: a.cover, alt: '' })
            : React.createElement('div', { key: 'c', className: 'xmly-anchor-avatar-lg xmly-album-cover-ph' }, (a.nickname || '主').slice(0, 1)),
          React.createElement('div', { key: 'm', className: 'xmly-album-head-meta' }, [
            React.createElement('div', { key: 'n', className: 'xmly-anchor-name-lg' }, a.nickname || ('主播 #' + a.uid)),
            React.createElement('div', { key: 's', className: 'xmly-muted' },
              fmtCount(a.fansCount) + ' 粉丝 · ' + a.albumCount + ' 专辑 · ' + fmtCount(a.trackCount) + ' 声音'),
            React.createElement('button', {
              key: 'back', className: 'xmly-btn xmly-btn-sm xmly-btn-ghost',
              onClick: () => set({ tab: 'mine', mineSeg: 'anchors' }),
            }, '‹ 返回关注列表'),
          ]),
        ]),
        a.description ? React.createElement('div', { key: 'd', className: 'xmly-muted xmly-anchor-desc' }, a.description) : null,
        s.anchorError ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.anchorError) : null,
        s.anchorLoading
          ? React.createElement('div', { key: 'ld', className: 'xmly-empty' }, '主播专辑加载中…')
          : (s.anchorAlbums.length === 0
              ? React.createElement('div', { key: 'e', className: 'xmly-empty' }, '该主播暂无公开专辑')
              : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                  s.anchorAlbums.map((al) => React.createElement('div', {
                    key: al.id, className: 'xmly-album-card', onClick: () => void openAlbum(al.id),
                  }, [
                    al.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: al.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                    React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                      React.createElement('div', { key: 't', className: 'xmly-album-title' },
                        al.title,
                        al.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null),
                      React.createElement('div', { key: 'a', className: 'xmly-muted' },
                        (al.isFinished ? '完结' : '连载') + ' · ' + al.trackCount + ' 集' + (al.playCount ? ' · ' + fmtCount(al.playCount) + ' 次播放' : '')),
                    ]),
                  ])))),
        !s.anchorLoading && s.anchorTotal > s.anchorAlbums.length && s.anchorAlbums.length > 0
          ? React.createElement('div', { key: 'more', className: 'xmly-empty xmly-empty-thin' },
              '已显示 ' + s.anchorAlbums.length + ' / ' + s.anchorTotal + ' 个专辑（网页端查看更多）')
          : null,
      ]);
    }

    function PlayerPanel() {
      const s = useStore();
      const headerRef = useRef(null);
      const onDragStart = useDragPanel(headerRef);
      if (!s.panelOpen) return null;
      // 渲染时也钳制（恢复的位置可能压输入区 / 窗口尺寸变了）。
      const pos = clampPanelPos(s.panelPos || { x: Math.max(16, Math.round((window.innerWidth - PANEL_W) / 2)), y: 80 });
      const maxH = Math.max(PANEL_MIN_H, window.innerHeight - pos.y - PANEL_RESERVE_BOTTOM);
      const style = { left: pos.x, top: pos.y, width: PANEL_W, maxHeight: maxH };
      return React.createElement('div', { className: 'xmly-panel', style },
        React.createElement('div', { className: 'xmly-panel-head', ref: headerRef, onMouseDown: onDragStart }, [
          React.createElement('span', { key: 't', className: 'xmly-panel-title' }, '📻 有声书'),
          React.createElement('div', { key: 'plats', className: 'xmly-panel-plats' },
            platformList().map((p) => {
              const acc = s.accountList.find((a) => a.id === p.id);
              const dot = acc && acc.loggedIn ? ' ●' : '';
              const tag = acc && acc.isVip ? ' VIP' : '';
              const title = (p.label || p.id) + (acc && acc.loggedIn
                ? '：' + (acc.nickname || '已登录') + (acc.isVip
                  ? '（' + (Number(acc.vipLevel) > 0 ? 'VIP Lv' + acc.vipLevel : 'VIP')
                    + (Number(acc.vipDays) > 0 ? '，剩 ' + acc.vipDays + ' 天' : '') + '）'
                  : '（普通账号）')
                : '：未登录');
              return React.createElement('button', {
                key: p.id,
                title,
                className: 'xmly-plat-btn' + (s.platform === p.id ? ' active' : ''),
                onClick: () => void switchPlatform(p.id),
              }, (p.label || p.id) + tag + dot);
            })),
          React.createElement('div', { key: 'tabs', className: 'xmly-panel-tabs' }, [
            React.createElement('button', { key: 's', className: 'xmly-tab-btn' + (s.tab === 'search' ? ' active' : ''), onClick: () => set({ tab: 'search' }) }, '搜索'),
            s.album !== null
              ? React.createElement('button', { key: 'a', className: 'xmly-tab-btn' + (s.tab === 'album' ? ' active' : ''), onClick: () => set({ tab: 'album' }) }, '专辑')
              : null,
            s.anchorView !== null
              ? React.createElement('button', { key: 'an', className: 'xmly-tab-btn' + (s.tab === 'anchor' ? ' active' : ''), onClick: () => set({ tab: 'anchor' }) }, '主播')
              : null,
            React.createElement('button', { key: 'm', className: 'xmly-tab-btn' + (s.tab === 'mine' ? ' active' : ''), onClick: () => set({ tab: 'mine' }) }, '我的'),
          ]),
          React.createElement('button', {
            key: 'x', className: 'xmly-bar-btn', title: '收起面板',
            onClick: () => { set({ panelOpen: false }); persistPanel(); },
          }, '✕'),
        ]),
        React.createElement('div', { className: 'xmly-panel-body' },
          s.tab === 'search' ? React.createElement(SearchTab, { key: 'search' }) : null,
          s.tab === 'album' ? React.createElement(AlbumTab, { key: 'album' }) : null,
          s.tab === 'anchor' ? React.createElement(AnchorTab, { key: 'anchor' }) : null,
          s.tab === 'mine' ? React.createElement(MineTab, { key: 'mine' }) : null,
        ),
      );
    }

    // ------------------------------------------------------------------
    // audio 事件绑定
    // ------------------------------------------------------------------
    function bindAudio() {
      const onTime = () => {
        if (Math.abs(audio.currentTime - store.position) > 0.25) set({ position: audio.currentTime });
      };
      const onDur = () => set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
      const onPlay = () => set({ playing: true, error: '', restored: false, buffering: false });
      // 暂停也要清 buffering：否则缓冲中（⋯）暂停后按钮会永远停在三个点。
      const onPause = () => {
        if (store.playing || store.buffering) set({ playing: false, buffering: false });
        persistPlayback();
      };
      const onEnded = () => {
        set({ playing: false, position: 0 });
        void step(1);
      };
      const onWaiting = () => set({ buffering: true });
      const onPlaying = () => { originRetried = false; set({ buffering: false }) };
      // 插件热重载后回环端口会换一个：地址失效时重取一次基址再重试（只试一次，避免死循环）。
      const onErr = () => {
        const cur = store.current;
        const src = String(audio.currentSrc || audio.src || '');
        const onLoopback = store.audioBase !== '' && src.indexOf(store.audioBase) === 0;
        if (onLoopback && !originRetried && cur && cur.trackId) {
          originRetried = true;
          set({ buffering: true, error: '' });
          void (async () => {
            await loadAudioOrigin();
            audio.src = streamUrl(cur.trackId, { albumId: cur.albumId, section: cur.section, tmeId: cur.tmeId });
            audio.playbackRate = store.rate;
            if (store.position > 5) { try { audio.currentTime = store.position } catch (e) { /* ignore */ } }
            try { await audio.play() } catch (e) { /* 交给 onErr 兜底 */ }
          })();
          return;
        }
        set({
          playing: false, buffering: false,
          error: '音频加载失败' + (store.current && store.current.quality ? '（' + store.current.quality + '）' : '') + '，可稍后重试',
        });
      };
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('durationchange', onDur);
      audio.addEventListener('loadedmetadata', onDur);
      audio.addEventListener('play', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('waiting', onWaiting);
      audio.addEventListener('playing', onPlaying);
      audio.addEventListener('error', onErr);
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('durationchange', onDur);
        audio.removeEventListener('loadedmetadata', onDur);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('waiting', onWaiting);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('error', onErr);
      };
    }

    // ------------------------------------------------------------------
    // plugin 入口
    // ------------------------------------------------------------------
    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-tingbar');
        styleEl.textContent = XMLY_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      }, 'ximalaya: style');

      ctx.effect(() => {
        if (!audioAttached) {
          audioAttached = true;
          try {
            audio.style.display = 'none';
            audio.volume = store.volume;
            if (audio.parentNode === null) document.body.appendChild(audio);
          } catch (e) {}
        }
        const unbind = bindAudio();
        const onHide = () => { persistPlayback(); };
        window.addEventListener('pagehide', onHide);
        return () => {
          window.removeEventListener('pagehide', onHide);
          try { audio.pause(); } catch (e) {}
          unbind();
        };
      }, 'ximalaya: audio engine');

      void loadManifest();

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'ximalaya-player', order: -1 },
        (props) => React.createElement(NowPlayingBar, props),
      )), 'ximalaya: now playing bar');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'ximalaya-panel', order: 21 },
        () => React.createElement(PlayerPanel),
      )), 'ximalaya: panel');

      // 意图轮询：放在 effect 里创建/清理，避免 slots.inject 抛错时 timer 泄漏。
      ctx.effect(() => {
        const intentTimer = setInterval(() => {
          apiGet('/dsh-tingbar/intent').then((res) => {
            if (res && res.ok === true && res.intent) return handleIntent(res.intent);
          }).catch(() => {});
        }, 2000);
        return () => clearInterval(intentTimer);
      }, 'ximalaya: intent poll');

      // 诊断：每次 bundle 加载（=用户刷新页面）留一条 boot 记录，
      // 命令行据此确认「页面里跑的是哪一版 Web 端代码」。
      setTimeout(() => { diag('boot', { build: CLIENT_BUILD }); }, 1500);
    }

    exports.apply = apply;
    exports.inject = inject;

    // ------------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------------
    const XMLY_CSS = '' +
      'body { --xmly-accent: var(--dsw-alias-brand-primary, #2f9e6e); --xmly-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      '.xmly-bar-wrap { box-sizing: border-box; width: 100%; position: relative; }\n' +
      '.xmly-bar { box-sizing: border-box; display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 6px 8px 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; cursor: default; user-select: none; position: relative; }\n' +
      '.xmly-bar-head { display: flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer; }\n' +
      '.xmly-note { color: var(--xmly-accent, #2f9e6e); flex: none; font-size: 13px; }\n' +
      '.xmly-bar-cover { flex: none; width: 24px; height: 24px; border-radius: 5px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); }\n' +
      '.xmly-bar-title { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }\n' +
      '.xmly-bar-track { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; font-size: 12px; }\n' +
      '.xmly-bar-hint { font-weight: 400; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.xmly-bar-album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; opacity: 0.75; }\n' +
      '.xmly-bar-time { flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }\n' +
      '.xmly-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 11px; cursor: pointer; padding: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.xmly-bar-ctrl { display: flex; align-items: center; justify-content: center; gap: 2px; flex: none; }\n' +
      '.xmly-bar-meta { display: flex; align-items: center; gap: 4px; flex: none; min-width: 0; }\n' +
      '.xmly-rail { display: flex; justify-content: center; }\n' +
      '.xmly-rail-btn { width: 100%; height: 30px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 15px; cursor: pointer; border-radius: 6px; line-height: 1; }\n' +
      '.xmly-rail-btn:hover { color: var(--xmly-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }\n' +
      '.xmly-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; height: 22px; min-width: 24px; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 4px; border-radius: 4px; }\n' +
      '.xmly-bar-btn:hover { color: var(--xmly-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }\n' +
      '.xmly-bar-btn.active { color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-bar-play { font-size: 15px; }\n' +
      '.xmly-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; overflow: hidden; border-radius: 0 0 8px 8px; cursor: pointer; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.15)); }\n' +
      '.xmly-progress-compact { height: 3px; }\n' +
      '.xmly-progress-fill { height: 100%; background: var(--xmly-accent, #2f9e6e); transition: width 0.15s linear; }\n' +
      '.xmly-pop { position: absolute; z-index: 10; background: var(--dsw-alias-bg-layer-2, #2a2a30); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.25); padding: 8px 10px; }\n' +
      '.xmly-vol-inline { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }\n' +
      '.xmly-vol-inline input[type="range"] { -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; height: 6px; background: transparent; outline: none; cursor: pointer; }\n' +
      '.xmly-vol-inline input[type="range"]::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: linear-gradient(to right, var(--xmly-accent, #2f9e6e) var(--vol-pct, 0%), var(--dsw-alias-border-l1, rgba(128,128,128,0.4)) var(--vol-pct, 0%)); }\n' +
      '.xmly-vol-inline input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 6px; height: 6px; border-radius: 50%; background: var(--xmly-accent, #2f9e6e); margin-top: -2px; }\n' +
      '.xmly-step-pop { right: 84px; bottom: calc(100% + 6px); width: 172px; display: flex; flex-direction: column; gap: 6px; }\n' +
      '.xmly-step-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.xmly-step-choices { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
      '.xmly-chip.active { color: var(--xmly-accent, #2f9e6e); background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 18%, transparent); }\n' +
      '.xmly-toast { position: absolute; left: 50%; transform: translateX(-50%); top: -30px; background: var(--dsw-alias-bg-layer-2, #2a2a30); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 4px 12px; font-size: 12px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.3); }\n' +
      '.xmly-toast-bad { color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      // ---- panel ----
      '.xmly-panel { position: fixed; z-index: 60; display: flex; flex-direction: column; max-height: 78vh; min-height: 320px; background: var(--dsw-alias-bg-layer-2, #232329); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 12px; box-shadow: 0 12px 48px rgba(0,0,0,0.4); overflow: hidden; user-select: none; }\n' +
      '.xmly-panel-head { display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; padding: 10px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); cursor: move; flex: none; min-width: 0; }\n' +
      '.xmly-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); white-space: nowrap; flex: none; }\n' +
      '.xmly-panel-tabs { display: flex; flex-wrap: nowrap; gap: 4px; margin-left: auto; flex: none; }\n' +
      // ---- 平台切换（喜马拉雅 / 懒人听书）----
      '.xmly-panel-plats { display: flex; gap: 2px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); border-radius: 8px; padding: 2px; }\n' +
      '.xmly-plat-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; padding: 4px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; flex: none; }\n' +
      '.xmly-plat-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-plat-btn.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 24%, transparent); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }\n' +
      '.xmly-gate { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 18px; text-align: center; }\n' +
      '.xmly-gate-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-tab-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; flex: none; }\n' +
      '.xmly-tab-btn:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-tab-btn.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 22%, transparent); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }\n' +
      '.xmly-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 12px; }\n' +
      '.xmly-panel-body::-webkit-scrollbar { width: 8px; }\n' +
      '.xmly-panel-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 4px; }\n' +
      '.xmly-tab-body { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.xmly-muted { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.xmly-empty { text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 28px 12px; }\n' +
      '.xmly-empty-thin { padding: 10px 12px; }\n' +
      '.xmly-error-text { color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; padding: 4px 0; }\n' +
      // ---- search ----
      '.xmly-search-row { display: flex; gap: 8px; }\n' +
      '.xmly-input { flex: 1; box-sizing: border-box; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.2)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; padding: 7px 10px; outline: none; }\n' +
      '.xmly-input:focus { border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-btn { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; border-radius: 8px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }\n' +
      '.xmly-btn:hover { border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-btn:disabled { opacity: 0.55; cursor: default; }\n' +
      '.xmly-btn-primary { background: var(--xmly-accent, #2f9e6e); border-color: transparent; color: var(--xmly-accent-fg, #fff); font-weight: 600; }\n' +
      '.xmly-btn-primary:hover { filter: brightness(1.08); }\n' +
      '.xmly-btn-fav { color: #ff6b81; border-color: #ff6b81; }\n' +
      '.xmly-btn-subbed { color: var(--xmly-accent, #2f9e6e); border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-cloud-op { flex: none; font-size: 11px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 11px; background: transparent; }\n' +
      '.xmly-cloud-op:hover { color: var(--dsw-alias-state-warn-primary, #d9a441); border-color: var(--dsw-alias-state-warn-primary, #d9a441); background: transparent; }\n' +
      '.xmly-btn-ghost { background: transparent; }\n' +
      '.xmly-btn-sm { padding: 3px 8px; font-size: 11px; }\n' +
      '.xmly-btn-block { width: 100%; text-align: center; }\n' +
      '.xmly-history { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n' +
      '.xmly-chip { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.14)); border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; border-radius: 10px; padding: 3px 10px; cursor: pointer; }\n' +
      '.xmly-chip:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      // ---- 排行榜（搜索页内嵌）----
      '.xmly-ranks { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }\n' +
      '.xmly-rank-cats { display: flex; gap: 8px; flex-wrap: wrap; }\n' +
      '.xmly-select { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; outline: none; }\n' +
      '.xmly-select:focus { border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-rank-board { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.xmly-rank-title { display: flex; align-items: baseline; gap: 8px; padding: 0 2px; }\n' +
      '.xmly-rank-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-rank-no { flex: none; width: 18px; text-align: center; font-size: 12px; font-weight: 700; color: var(--dsw-alias-label-secondary, #8a8f98); align-self: center; }\n' +
      '.xmly-rank-no.top { color: var(--xmly-accent, #2f9e6e); }\n' +
      // ---- album cards ----
      '.xmly-album-list { display: flex; flex-direction: column; gap: 8px; }\n' +
      '.xmly-album-card { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-album-card:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-album-cover { flex: none; width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); }\n' +
      '.xmly-album-cover-ph { display: flex; align-items: center; justify-content: center; font-size: 20px; }\n' +
      '.xmly-album-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }\n' +
      '.xmly-album-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }\n' +
      '.xmly-album-intro { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }\n' +
      '.xmly-album-stat { display: flex; gap: 8px; }\n' +
      '.xmly-badge { flex: none; font-size: 10px; border-radius: 4px; padding: 1px 5px; font-weight: 400; }\n' +
      '.xmly-badge-paid { background: rgba(217,164,65,0.18); color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.xmly-badge-vip { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 22%, transparent); color: var(--xmly-accent, #2f9e6e); }\n' +
      // ---- album detail ----
      '.xmly-album-head { display: flex; gap: 12px; }\n' +
      '.xmly-album-cover-lg { flex: none; width: 84px; height: 84px; border-radius: 10px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); }\n' +
      '.xmly-album-head-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }\n' +
      '.xmly-album-title-lg { font-size: 14px; font-weight: 700; color: var(--dsw-alias-label-primary, #e6e6e6); line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }\n' +
      '.xmly-album-ops { display: flex; gap: 8px; margin-top: 4px; }\n' +
      '.xmly-album-intro-full { font-size: 11px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }\n' +
      '.xmly-track-list { display: flex; flex-direction: column; }\n' +
      '.xmly-track-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }\n' +
      '.xmly-track-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-track-row.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 16%, transparent); }\n' +
      '.xmly-track-row.active .xmly-track-title { color: var(--xmly-accent, #2f9e6e); font-weight: 600; }\n' +
      '.xmly-track-idx { flex: none; width: 22px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }\n' +
      '.xmly-track-title { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-track-dur { flex: none; font-variant-numeric: tabular-nums; }\n' +
      // ---- mine ----
      '.xmly-login-box { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 10px; padding: 12px; }\n' +
      '.xmly-user-row { display: flex; align-items: center; gap: 10px; }\n' +
      '.xmly-avatar { flex: none; width: 36px; height: 36px; border-radius: 50%; background: var(--xmly-accent, #2f9e6e); color: var(--xmly-accent-fg, #fff); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; object-fit: cover; }\n' +
      '.xmly-user-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-user-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); display: flex; align-items: center; gap: 6px; }\n' +
      '.xmly-qr-box { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 6px 0; }\n' +
      '.xmly-qr-img { width: 168px; height: 168px; border-radius: 10px; background: #fff; object-fit: contain; }\n' +
      '.xmly-qr-ph { display: flex; align-items: center; justify-content: center; color: #8a8f98; font-size: 13px; }\n' +
      '.xmly-qr-status { margin-top: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; text-align: center; }\n' +
      '.xmly-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); margin-top: 4px; }\n' +
      // ---- mine: segmented + likes + anchors ----
      '.xmly-seg-row { display: flex; gap: 4px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); border-radius: 8px; padding: 3px; }\n' +
      '.xmly-seg-btn { flex: 1 1 0; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 6px 2px; border-radius: 6px; cursor: pointer; white-space: nowrap; }\n' +
      '.xmly-seg-btn.active { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.28)); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }\n' +
      '.xmly-seg-row-wrap { display: flex; align-items: center; gap: 6px; }\n' +
      '.xmly-seg-row-wrap .xmly-seg-row { flex: 1 1 auto; min-width: 0; }\n' +
      '.xmly-mine-refresh { flex: 0 0 auto; white-space: nowrap; }\n' +
      '.xmly-mine-subbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; padding: 2px 0 4px; }\n' +
      '.xmly-load-sentinel { padding: 10px 0 4px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.xmly-like-list { display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-like-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-like-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-like-row.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 16%, transparent); }\n' +
      '.xmly-like-row.active .xmly-like-title-text { color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-like-cover { flex: none; width: 42px; height: 42px; border-radius: 8px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 16px; }\n' +
      '.xmly-like-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-like-title { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.xmly-like-title-text { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-like-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-like-play { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 18%, transparent); color: var(--xmly-accent, #2f9e6e); font-size: 11px; }\n' +
      '.xmly-anchor-list { display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-anchor-card { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-anchor-card:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-anchor-avatar { flex: none; width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 14px; }\n' +
      '.xmly-anchor-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-anchor-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-anchor-go { flex: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 16px; }\n' +
      '.xmly-anchor-head { display: flex; gap: 12px; align-items: center; }\n' +
      '.xmly-anchor-avatar-lg { flex: none; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 18px; }\n' +
      '.xmly-anchor-name-lg { font-size: 14px; font-weight: 700; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-anchor-desc { font-size: 11px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }\n' +
      '@media (max-width: 560px) { .xmly-panel { left: 8px !important; right: 8px; width: auto !important; } }\n';

    return module.exports;
  },
});
