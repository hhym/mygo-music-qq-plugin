import { qqSignIn } from './auth-qq.js';
import { wechatSignIn, wechatDeviceComm, refreshWechatSession } from './auth-wechat.js';
import { decodeQR } from './qr.js';
import { decodeQRC } from './qrc-lyrics.js';
import { wechatRandom, wechatCookieFetch } from './wechat-host.js';

const API = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const headers = { "Content-Type": "application/json", "Referer": "https://y.qq.com/", "User-Agent": "Mozilla/5.0" };
const pageSize = 20;
const searchPages = new Map();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function rpc(module, method, param, comm) {
  // QQ's comment endpoint is a public web API and rejects account cookies.
  const auth = module === "music.globalComment.CommentRead" ? null : qqAuthContext();
  comm = comm || auth?.comm || { ct: 24, cv: 0 };
  const response = await fetch(API, { method: "POST", headers: auth ? { ...headers, Cookie: auth.cookie } : headers, body: JSON.stringify({ comm, req_0: { module, method, param } }) });
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 0 || !body.req_0 || body.req_0.code !== 0 || body.req_0.subcode) throw new Error(`QQ Music ${method}: ${body.code}/${body.req_0?.code ?? "missing"}`);
  if (!body.req_0.data) throw new Error(`QQ Music ${method}: missing data`);
  return body.req_0.data;
}

async function cgi(path, params) {
  const query = Object.entries({ ...params, format: "json", outCharset: "utf-8" }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const auth = qqAuthContext();
  const response = await fetch(`https://c.y.qq.com${path}?${query}`, { headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0", ...(auth ? { Cookie: auth.cookie } : {}) } });
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== 0 || body.subcode) throw new Error(`QQ Music: ${body.code}`);
  return body;
}

function artistOf(a = {}) {
  const mid = a.mid || a.singermid || a.singer_mid || a.singerMid || a.singerMID || "";
  return { id: String(mid), name: String(a.name || a.singername || a.singer_name || a.singerName || ""), imageUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : "" };
}

// The app reads released as a string, so a bare number from QQ (a unix
// timestamp or an YYYYMMDD) would fail the whole page at the JSON boundary.
function releasedOf(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const digits = String(Math.trunc(value));
    if (/^(19|20)\d{6}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    // QQ's timestamps are Beijing time, so read the date there rather than in UTC.
    const date = new Date((value + 8 * 3600) * 1000);
    if (!Number.isNaN(date.getTime()) && date.getFullYear() > 1970) return date.toISOString().slice(0, 10);
    return "";
  }
  return String(value);
}

function albumOf(a = {}) {
  const mid = a.mid || a.albummid || a.album_mid || a.albumMid || a.albumMID || "";
  return { id: String(mid), name: String(a.name || a.title || a.albumname || a.album_name || a.albumName || ""), imageUrl: String(a.albumPic || (mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : "")), artists: (a.singer || a.singer_list || []).map(artistOf), released: releasedOf(a.publicTime ?? a.aDate ?? a.time_public) };
}

function trackOf(raw) {
  const t = raw.musicData || raw.songInfo || raw.track_info || raw;
  const mid = t.mid || t.songmid || t.songMid || "";
  const album = t.album || { albummid: t.albummid || t.album_mid, albumname: t.albumname || t.album_name };
  return { id: String(mid), name: t.title || t.name || t.songname || t.songName || "", artists: (t.singer || t.singers || []).map(artistOf), album: albumOf(album), duration: (Number(t.interval) || 0) * 1000, url: `https://y.qq.com/n/ryqq/songDetail/${mid}` };
}

// A search answered 2001 is QQ throttling, not a refusal: the same request
// goes through a moment later, so give it two more chances.
async function retrying(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 2 || !/2001/.test(error.message || "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

export async function search({ query, kind, offset = 0 }) {
  if (kind === "playlists") return qqBrowse.searchPlaylists({ query, offset });
  const kinds = { tracks: [0, "song", trackOf], artists: [1, "singer", artistOf], albums: [2, "album", albumOf] };
  const spec = kinds[kind];
  if (!spec) fail("unsupported", "This search type is not supported");
  query = query.trim();
  if (!query) return { [kind]: [], more: false };
  const key = `${kind}\0${query}`;
  if (!offset) searchPages.set(key, new Map());
  const pages = searchPages.get(key);
  const page = pages?.get(offset) || Math.floor(offset / pageSize) + 1;
  const session = qqReadSession();
  const comm = { ct: 11, cv: 0, uin: session?.musicid || "0", format: "json", tmeAppID: "qqmusic" };
  if (session) Object.assign(comm, { qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType });
  const data = await retrying(() => rpc("music.search.SearchCgiService", "DoSearchForQQMusicDesktop", { query, search_type: spec[0], num_per_page: pageSize, page_num: page }, comm));
  if (data.code) throw new Error(`QQ Music search: ${data.code}`);
  const list = data.body?.[spec[1]]?.list;
  if (!Array.isArray(list) || !data.meta) throw new Error("QQ Music: malformed search response");
  if (!list.length && Number(data.meta.is_filter) < 0) throw new Error("QQ Music search was filtered; try again later");
  const found = list.map(spec[2]).filter(item => item.id);
  const more = list.length > 0 && page * pageSize < Number(data.meta.sum || 0);
  if (more && found.length && pages) pages.set(offset + found.length, page + 1);
  return { [kind]: found, more };
}

export async function suggest({ query }) {
  query = query.trim();
  if (!query) return [];
  const result = await cgi("/splcloud/fcgi-bin/smartbox_new.fcg", { key: query, inCharset: "utf-8", platform: "yqq", needNewCode: "0" });
  if (!result.data) throw new Error("QQ Music: malformed search suggestions");
  const groups = ["song", "singer", "album"].map(key => result.data[key]).filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0));
  return [...new Set(groups.flatMap(group => (group.itemlist || []).map(item => item?.name).filter(Boolean)))];
}

export async function stream({ id, quality = "standard" }) {
  const detail = await rpc("music.pf_song_detail_svr", "get_song_detail_yqq", { song_type: 0, song_mid: id, song_id: "0" });
  const t = detail.track_info;
  if (!t || (t.mid || t.songmid) !== id) fail("unavailable", "Song details are unavailable");
  const media = t.file?.media_mid || t.strMediaMid || t.media_mid || id;
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000);
  const session = qqReadSession();
  const qualities = [{ prefix: "M500", type: "mp3", quality: "standard", size: t.file?.size_128mp3 }];
  if (session && (quality === "high" || quality === "lossless")) qualities.unshift({ prefix: "M800", type: "mp3", quality: "high", size: t.file?.size_320mp3 });
  if (session && quality === "lossless") qualities.unshift({ prefix: "F000", type: "flac", quality: "lossless", size: t.file?.size_flac });
  for (const q of qualities) {
    const param = { filename: [`${q.prefix}${id}${media}.${q.type}`], guid, songmid: [id], songtype: [0], uin: session?.musicid || "0" };
    if (session) param.ctx = 0;
    else { param.loginflag = 1; param.platform = "20"; }
    const data = await rpc(session ? "music.vkey.GetVkey" : "vkey.GetVkeyServer", session ? "UrlGetVkey" : "CgiGetVkey", param);
    const entry = (data.midurlinfo || []).find(item => (!item.songmid || item.songmid === id) && item.purl);
    if (!entry) continue;
    const base = (data.sip || []).find(url => /^https?:\/\/(?:[a-z0-9-]+\.)*(?:qqmusic\.qq\.com|qq\.com)(?::\d+)?\//i.test(url) && !/^http:\/\/ws/i.test(url)) || "http://dl.stream.qqmusic.qq.com/";
    return { url: new URL(entry.purl, base).href, type: q.type, quality: q.quality, size: Number(q.size) || 0, gain: Number(t.volume?.gain) || 0, peak: Number(t.volume?.peak) || 0, headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" } };
  }
  fail("unavailable", "QQ Music did not provide a playable stream");
}

function decodeLyric(value) {
  if (!value) return "";
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

async function lyricTranslation(id) {
  try {
    const comm = { ct: 11, cv: "1003006", v: "1003006", tmeAppID: "qqmusiclight", nettype: "NETWORK_WIFI", udid: "0", uid: "0" };
    const result = await rpc("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", { songMID: id, songName: "", singerName: "", albumName: "", interval: 0, crypt: 0, ct: 19, cv: 2111, lrc_t: 0, qrc: 0, qrc_t: 0, roma: 0, roma_t: 0, trans: 1, trans_t: 0, type: 0 }, comm);
    const candidate = decodeLyric(result.trans);
    return /\[\d{1,3}:\d{2}/.test(candidate) ? candidate : "";
  } catch { return ""; }
}

export async function lyrics({ id }) {
  try {
    const data = await rpc("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", { songMID: id, crypt: 1, ct: 24, cv: 0, lver: 0, qrc: 1, trans: 1, roma: 0 });
    const original = decodeQRC(data.lyric || "");
    const lines = parseQRC(original);
    if (lines.length) {
      let translation = "";
      try { translation = decodeQRC(data.trans || ""); } catch { /* Some songs have no encrypted translation. */ }
      if (!translation) translation = await lyricTranslation(id);
      if (translation) attachLyricTranslations(lines, translation);
      return { lines, translation };
    }
    if (/\[\d{1,3}:\d{2}/.test(original)) return { lrc: original, translation: decodeQRC(data.trans || "") };
  } catch { /* QQ may not have QRC for this song; use the ordinary lyrics. */ }
  const data = await cgi("/lyric/fcgi-bin/fcg_query_lyric_new.fcg", { songmid: id });
  let translation = decodeLyric(data.trans);
  if (!translation) translation = await lyricTranslation(id);
  return { lrc: decodeLyric(data.lyric), translation };
}

export function parseQRC(input) {
  const wrapped = /\bLyricContent="([\s\S]*?)"/.exec(input);
  const content = wrapped ? decodeEntities(wrapped[1]) : input;
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(\d+),(\d+)\]/.exec(line);
    if (!header) continue;
    const start = Number(header[1]);
    let end = start + Number(header[2]);
    const body = line.slice(header[0].length), words = [], tags = /\((\d+),(\d+)\)/g;
    let match, at = 0;
    while ((match = tags.exec(body))) {
      const text = body.slice(at, match.index);
      at = tags.lastIndex;
      if (!text) continue;
      const wordStart = Number(match[1]), wordEnd = wordStart + Number(match[2]);
      words.push({ start: wordStart, end: wordEnd, text });
      end = Math.max(end, wordEnd);
    }
    const text = words.map(word => word.text).join("").trim();
    if (text && !body.slice(at).trim()) lines.push({ start, end, text, words });
  }
  return lines.sort((a, b) => a.start - b.start);
}

function attachLyricTranslations(lines, translation) {
  for (const raw of translation.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const text = raw.slice(last.index + last[0].length).trim();
    if (!text) continue;
    for (const match of matches) {
      const time = Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number(`0.${match[3] || 0}`) * 1000;
      let best, gap = 1500;
      for (const line of lines) {
        const distance = Math.abs(line.start - time);
        if (distance < gap) { best = line; gap = distance; }
      }
      if (best && !best.translation) best.translation = text;
    }
  }
}

export async function album({ id }) {
  const body = await cgi("/v8/fcg-bin/fcg_v8_album_info_cp.fcg", { albummid: id });
  const data = body.data;
  if (!data) fail("unavailable", "Album not found");
  const tracks = (data.list || data.songlist || []).map(trackOf).filter(t => t.id);
  const result = albumOf(data);
  if (!result.id) result.id = id;
  if (!result.artists.length && tracks.length) result.artists = tracks[0].artists;
  const session = qqReadSession();
  if (session) {
    const numeric = Number(session.musicid);
    const owner = Number.isSafeInteger(numeric) ? numeric : session.musicid;
    const status = await qqAuthRpc("music.musicasset.AlbumFavRead", "IsAlbumFan", { uin: owner, v_albumMid: [id] }, session);
    if (typeof status.m_fan?.[id] !== "boolean") throw new Error("QQ Music missing album saved status");
    result.saved = status.m_fan[id];
  }
  return { album: result, tracks };
}

export async function artist({ id }) {
  const data = await rpc("music.web_singer_info_svr", "get_singer_detail_info", { sort: 5, singermid: id, sin: 0, num: 50 });
  const result = artistOf(data.singer_info || {});
  if (!result.id) result.id = id;
  const list = await rpc("music.musichallAlbum.AlbumListServer", "GetAlbumList", { sort: 5, singermid: id, begin: 0, num: 50 }, { ct: 24, cv: 0 });
  const albums = (list.albumList || list.albumlist || []).map(albumOf).filter(a => a.id);
  return { artist: result, tracks: (data.songlist || []).map(trackOf).filter(t => t.id), albums };
}

export function stations() {
  return [{ id: "personal-fm", name: host.t("Personal FM") }];
}

export async function stationNext({ id }) {
  if (id !== "personal-fm") fail("unavailable", "Unknown station");
  if (!qqReadSession()) fail("signIn", "Sign in to QQ Music");
  const data = await rpc("music.radioProxy.MbTrackRadioSvr", "get_radio_track", { id: 99, firstplay: 1, num: 15 });
  if (!Array.isArray(data.tracks)) throw new Error("QQ Music: malformed radio response");
  return data.tracks.map(trackOf).filter(track => track.id);
}

// What the session is kept in: host.storage is persistent JSON, not a secret store.
const qqAuthStorageKey = "qqmusic.auth.v1";
const qqAuthURL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

function qqAuthError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function qqSession(value) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.musicid === "string" ? value.musicid : "";
  const key = typeof value.musickey === "string" ? value.musickey : "";
  if (!/^[0-9]+$/.test(id) || !/[1-9]/.test(id) || !key || /[;\s]/.test(key) || ![1, 2].includes(value.loginType)) return null;
  return { ...value, musicid: id, musickey: key, loginType: value.loginType };
}

function qqReadSession() {
  return qqSession(host.storage.get(qqAuthStorageKey));
}
export { qqReadSession, qqAuthContext, qqAuthRpc };

function qqAuthContext(session = qqReadSession()) {
  session = qqSession(session);
  if (!session) return null;
  return {
    comm: { ...(session.device ? wechatDeviceComm(session.device) : { ct: 11, cv: 14090008, v: 14090008, chid: "10003505", tmeAppID: "qqmusic" }), qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType },
    cookie: `uin=${session.musicid}; qqmusic_uin=${session.musicid}; qm_keyst=${session.musickey}; qqmusic_key=${session.musickey}`,
  };
}

// Explicit sessions let signIn validate before persistence.
async function qqAuthRpc(module, method, param, session = qqReadSession()) {
  const auth = qqAuthContext(session);
  if (!auth) throw qqAuthError("Sign in to QQ Music", "signIn");
  const response = await fetch(qqAuthURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Referer": "https://y.qq.com/", "User-Agent": "QQMusic 14090008(android 10)", "Cookie": auth.cookie },
    body: JSON.stringify({ comm: auth.comm, req_0: { module, method, param } }),
  });
  if (!response.ok) throw qqAuthError(`QQ Music HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body.code !== "number" || !body.req_0 || typeof body.req_0.code !== "number") throw qqAuthError("QQ Music returned a malformed response");
  const code = body.req_0.code || body.req_0.subcode || 0;
  if (body.code !== 0 || code !== 0) {
    const error = qqAuthError(`QQ Music ${method}: ${body.code}/${code}`);
    error.qqGlobalCode = body.code;
    error.qqCode = code;
    throw error;
  }
  if (body.req_0.data == null || typeof body.req_0.data !== "object") throw qqAuthError("QQ Music returned no data");
  return body.req_0.data;
}

async function qqAccountFor(session) {
  const data = await qqAuthRpc("music.UserInfo.userInfoServer", "GetLoginUserInfo", {}, session);
  if (!data.info || typeof data.info !== "object") throw qqAuthError("QQ Music returned no account information");
  const info = data.info;
  return { id: session.musicid, name: info.nick || info.nickname || session.musicid, imageUrl: info.headurl || info.logo || info.avatarUrl || info.avatar || "" };
}

export async function qqFinishSignIn(value) {
  const session = qqSession(value);
  if (!session) throw qqAuthError("QQ Music login returned an invalid credential");
  const profile = await qqAccountFor(session);
  host.storage.set(qqAuthStorageKey, session);
  return profile;
}

export async function signIn() {
  const method = (typeof host.setting === 'function' ? host.setting('loginMethod') : '').trim().toLowerCase();
  if (method && method !== 'qq' && method !== 'wechat' && method !== '微信') throw qqAuthError('Login method must be QQ or WeChat');
  const deps = { fetch, decodeQR, prompt: value => host.signInPrompt(value), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  if (method === 'wechat' || method === '微信') {
    deps.randomBytes = await wechatRandom(fetch, text => host.crypto.md5(text));
    deps.fetch = wechatCookieFetch(fetch);
    return qqFinishSignIn(await wechatSignIn(deps));
  }
  return qqFinishSignIn(await qqSignIn(deps));
}

export async function account() {
  let session = qqReadSession();
  if (!session) return null;
  try {
    return await qqAccountFor(session);
  } catch (error) {
    if (error.qqGlobalCode === 0 && [1000, 104400, 104401].includes(error.qqCode)) {
      if (session.loginType === 1 && (session.refresh_key || session.refresh_token) && session.device) {
        try {
          session = await refreshWechatSession(session, fetch);
          const profile = await qqAccountFor(session);
          host.storage.set(qqAuthStorageKey, session);
          return profile;
        } catch (refreshError) {
          if (refreshError.qqGlobalCode !== 0 || ![1000, 104400, 104401].includes(refreshError.qqCode)) throw refreshError;
        }
      }
      host.storage.remove(qqAuthStorageKey);
      return null;
    }
    throw error;
  }
}

export function signOut() {
  host.storage.remove(qqAuthStorageKey);
}

export function createBrowse({ rpc, cgi, trackOf, t = value => value }) {
  const cursors = new Map();
  const searchPages = new Map();
  const pc = { ct: 24, cv: 0 };
  const idOf = value => value == null ? "" : String(value);
  const list = (value, name) => {
    if (!Array.isArray(value)) throw new Error(`QQ Music: missing ${name}`);
    return value;
  };
  const tracksOf = items => items.map(trackOf).filter(track => track.id);
  const unavailable = message => { const error = new Error(message); error.code = "unavailable"; throw error; };

  // 听书（长音频）在搜索接口里是单独的一类，search_type 15 才给有声书专辑，
  // 2 只给唱片专辑；剧集本身仍是歌曲，走 album() 与 stream() 就能播。
  const audiobookCategories = () => [
    { key: "novels", title: t("Audiobook Novels"), query: "有声小说" },
    { key: "storytelling", title: t("Storytelling"), query: "评书 相声" },
    { key: "kids", title: t("Audiobook for Kids"), query: "儿童 睡前故事 有声" },
    { key: "history", title: t("History"), query: "历史 有声书" },
    { key: "business", title: t("Business"), query: "财经 有声书" },
    { key: "mystery", title: t("Mystery"), query: "悬疑 有声剧" },
    { key: "classics", title: t("Classics"), query: "国学 经典 有声书" },
    { key: "life", title: t("Life"), query: "情感 生活 有声书" },
  ];

  async function audiobooks({ query, offset = 0 }) {
    query = String(query || "").trim();
    if (!query) return { albums: [], more: false };
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
    const size = 30;
    const page = Math.floor(offset / size) + 1;
    const param = { query, search_type: 15, num_per_page: size, page_num: page };
    const comm = { ct: 11, cv: 0, uin: "0", format: "json", tmeAppID: "qqmusic" };
    const data = await retrying(() => rpc("music.search.SearchCgiService", "DoSearchForQQMusicDesktop", param, comm));
    if (data.code) throw new Error(`QQ Music audiobook search: ${data.code}`);
    const entries = list(data.body?.album?.list, "audiobook search results");
    if (!data.meta) throw new Error("QQ Music: missing search metadata");
    if (!entries.length && Number(data.meta.is_filter) < 0) throw new Error("QQ Music search was filtered; try again later");
    const albums = entries.map(item => ({ ...albumOf(item), trackCount: Number(item.song_count) || 0 })).filter(item => item.id);
    return { albums, more: albums.length > 0 && page * size < Number(data.meta.sum || 0) };
  }

  async function audiobooksPage() {
    const categories = audiobookCategories();
    // 同一时刻并发搜索容易被 QQ 限流（2001），所以这里串行取。
    const popular = await audiobooks({ query: "有声书" });
    const novels = await audiobooks({ query: "有声小说" });
    return {
      title: t("Audiobooks"),
      sections: [
        { title: t("Popular Audiobooks"), albums: popular.albums },
        { title: t("Audiobook Categories"), links: categories.map(category => ({ title: category.title, page: `audiobooks:${category.key}` })) },
        { title: t("Audiobook Novels"), albums: novels.albums },
      ],
    };
  }

  async function audiobookCategory(key) {
    const category = audiobookCategories().find(item => item.key === key);
    if (!category) unavailable("Unknown audiobook category");
    const { albums } = await audiobooks({ query: category.query });
    if (!albums.length) unavailable("Audiobooks are unavailable");
    return { title: category.title, sections: [{ albums }] };
  }

  async function featuredPlaylists() {
    const data = await rpc("music.playlist.PlaylistSquare", "GetRecommendFeed", { From: 0, Size: 60 });
    return list(data.List, "playlist feed").map(entry => {
      const b = entry.Playlist?.basic || {};
      return { id: idOf(b.tid), name: b.title || "", description: b.desc || "", trackCount: Number(b.song_cnt) || 0, imageUrl: b.cover?.default_url || b.cover?.big_url || b.cover?.medium_url || b.cover?.small_url || "", owner: b.creator?.nick || "" };
    }).filter(item => /^[1-9]\d*$/.test(item.id));
  }

  async function charts() {
    const data = await rpc("musicToplist.ToplistInfoServer", "GetAll", {}, pc);
    return list(data.group, "chart groups").flatMap(group => list(group.toplist, "chart list"))
      .filter(item => Number(item.recType) === 10005 && /^[1-9]\d*$/.test(idOf(item.topId)))
      .map(item => ({ id: `chart:${item.topId}`, name: item.title || "", imageUrl: item.headPicUrl || item.frontPicUrl || item.musichallPicUrl || "", description: item.intro || "", trackCount: Number(item.totalNum) || 0 }));
  }

  async function home() {
    const [featured, ranking] = await Promise.all([featuredPlaylists(), charts()]);
    return { title: t("QQ Music"), sections: [{ title: t("Featured Playlists"), playlists: featured }, { title: t("Charts"), playlists: ranking }] };
  }

  async function browse({ page }) {
    if (page === "playlists") return { title: t("Featured Playlists"), sections: [{ playlists: await featuredPlaylists() }] };
    if (page === "charts") return { title: t("Charts"), sections: [{ playlists: await charts() }] };
    if (page === "audiobooks") return audiobooksPage();
    if (page.startsWith("audiobooks:")) return audiobookCategory(page.slice("audiobooks:".length));
    unavailable("Unknown browse page");
  }

  async function playlist({ id }) {
    id = idOf(id);
    if (id.startsWith("chart:")) {
      const topid = id.slice(6);
      if (!/^[1-9]\d*$/.test(topid) || !Number.isSafeInteger(Number(topid))) unavailable("Invalid chart ID");
      const data = await rpc("musicToplist.ToplistInfoServer", "GetDetail", { topid: Number(topid), offset: 0, num: 100, period: "" }, pc);
      const info = data.data || {};
      if (Number(info.recType) !== 10005) unavailable("This chart is not a song chart");
      const tracks = tracksOf(list(data.songInfoList, "chart songs"));
      if (!tracks.length) unavailable("Chart songs are unavailable");
      return { id, name: info.title || "", imageUrl: info.headPicUrl || info.frontPicUrl || "", description: info.intro || "", trackCount: Number(info.totalNum) || tracks.length, tracks };
    }
    if (!/^[1-9]\d*$/.test(id)) unavailable("Invalid playlist ID");
    const data = await cgi("/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", { disstid: id, type: "1", json: "1", utf8: "1", onlysong: "0", new_format: "1" });
    const info = list(data.cdlist, "playlist details")[0];
    if (!info) unavailable("Playlist not found");
    const tracks = tracksOf(list(info.songlist, "playlist songs"));
    const trackCount = Number(info.total_song_num || info.songnum) || tracks.length;
    if (!tracks.length && trackCount > 0) unavailable("Playlist songs are unavailable");
    return { id, name: info.dissname || info.title || "", imageUrl: info.logo || info.picurl || "", description: info.desc || "", owner: info.nickname || info.nick || "", trackCount, tracks };
  }

  async function searchPlaylists({ query, offset = 0 }) {
    query = query.trim();
    if (!query) return { playlists: [], more: false };
    const size = 20;
    if (!offset) searchPages.set(query, new Map());
    const pages = searchPages.get(query);
    const page = pages?.get(offset) || Math.floor(Math.max(0, offset) / size) + 1;
    const data = await retrying(() => rpc("music.search.SearchCgiService", "DoSearchForQQMusicDesktop", { query, search_type: 3, num_per_page: size, page_num: page }, { ct: 11, cv: 0, uin: "0", format: "json", tmeAppID: "qqmusic" }));
    if (data.code) throw new Error(`QQ Music search: ${data.code}`);
    const entries = list(data.body?.songlist?.list, "playlist search results");
    if (!data.meta) throw new Error("QQ Music: missing search metadata");
    if (!entries.length && Number(data.meta.is_filter) < 0) throw new Error("QQ Music search was filtered; try again later");
    const playlists = entries.map(item => ({ id: idOf(item.dissid), name: item.dissname || "", imageUrl: item.imgurl || "", description: item.introduction || "", trackCount: Number(item.song_count) || 0, owner: item.creator?.name || "" })).filter(item => /^[1-9]\d*$/.test(item.id));
    const more = playlists.length > 0 && page * size < Number(data.meta.sum || 0);
    if (more && pages) pages.set(offset + playlists.length, page + 1);
    return { playlists, more };
  }

  async function comments({ trackId, offset = 0 }) {
    const key = idOf(trackId);
    if (!key || !Number.isInteger(offset) || offset < 0) unavailable("Invalid comment request");
    let cursor = offset ? cursors.get(key)?.get(offset) : null;
    if (offset && !cursor) unavailable("Comment cursor expired; reopen comments");
    if (!cursor) {
      const detail = await rpc("music.pf_song_detail_svr", "get_song_detail_yqq", { song_type: 0, song_mid: key, song_id: "0" });
      const song = detail.track_info;
      if (!song || (song.mid || song.songmid) !== key || !/^[1-9]\d*$/.test(idOf(song.id || song.songid))) unavailable("Song comment ID is unavailable");
      cursor = { thread: idOf(song.id || song.songid), sequence: "", page: 0, total: 0, version: "0", seen: new Set() };
    }
    const seen = new Set(cursor.seen);
    let comments, more, total;
    do {
      const data = await rpc("music.globalComment.CommentRead", "GetNewCommentList", { BizType: 1, BizId: cursor.thread, PageSize: 25, PageNum: cursor.page, LastCommentSeqNo: cursor.sequence, PicEnable: 1, FromCommentId: "", WithHot: 0, LastTotal: cursor.total, LastTotalVer: cursor.version }, pc);
      const section = data.CommentList;
      const entries = list(section?.Comments, "comments");
      const valid = entries.filter(item => idOf(item.CmId));
      if (entries.length && !valid.length) throw new Error("QQ Music: no valid comments");
      comments = valid.filter(item => {
        const id = idOf(item.CmId);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map(item => ({ id: idOf(item.CmId), author: item.Nick || "", avatarUrl: item.Avatar || "", text: decodeEntities(item.Content || ""), time: (Number(item.PubTime) || 0) * 1000, likes: Number(item.PraiseNum) || 0 }));
      const sequence = idOf(entries.length ? entries[entries.length - 1].SeqNo : "");
      more = !!sequence && sequence !== cursor.sequence && (section.HasMore === true || Number(section.HasMore) === 1);
      total = Number(section.Total) || 0;
      cursor = { thread: cursor.thread, sequence, page: cursor.page + 1, total, version: data.TotalVer ?? "0", seen };
    } while (!comments.length && more);
    if (!offset) cursors.set(key, new Map());
    if (more) cursors.get(key).set(offset + comments.length, cursor);
    return { comments, total, more };
  }

  return { home, browse, playlist, comments, searchPlaylists, featuredPlaylists, charts, audiobooks };
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
  });
}

const qqBrowse = createBrowse({ rpc, cgi, trackOf, t: text => host.t(text) });
export async function home() {
  const page = await qqBrowse.home();
  const session = qqReadSession();
  if (!session) return page;
  try {
    const comm = { ct: 20, cv: 13020008, qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType };
    const feed = await rpc("music.recommend.RecommendFeed", "get_recommend_feed", { direction: 0, page: 1, s_num: 0, v_cache: [] }, comm);
    if (feed.retcode !== 0 || !Array.isArray(feed.v_shelf)) throw new Error("QQ Music: malformed personal recommendations");
    const cards = feed.v_shelf.flatMap(shelf => shelf.v_niche || []).flatMap(niche => niche.v_card || []);
    const seen = new Set();
    const playlists = cards.filter(card => card.type === 500 && card.subtype === 0 && card.jumptype === 10014 && /^[1-9]\d*$/.test(String(card.id)) && !seen.has(String(card.id)) && seen.add(String(card.id)))
      .map(card => ({ id: String(card.id), name: card.title || "", imageUrl: card.cover || "" }));
    if (playlists.length) page.sections.unshift({ title: host.t("Recommended for You"), playlists });
  } catch (error) {
    console.warn(`QQ Music recommendations: ${error.message}`);
  }
  return page;
}
export const browse = qqBrowse.browse;
export const comments = qqBrowse.comments;

// Authenticated RPC and CGI must send the Cookie for the supplied session.
export function createLibrary({ qqAuthRpc, qqReadSession, qqAuthCgi, cgi, trackOf, fetch: fetchProfile = globalThis.fetch }) {
  async function account(optional = false) {
    const s = await qqReadSession();
    if (!s || !/^\d+$/.test(String(s.musicid || '')) || !s.musickey || !s.loginType) {
      if (optional) return null;
      const error = new Error('QQ Music login required');
      error.code = 'signIn';
      throw error;
    }
    return s;
  }
  const call = (s, module, method, param) => qqAuthRpc(module, method, param, s);
  function idNumber(value, what) {
    const n = Number(value);
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${what}`);
    return n;
  }
  function mid(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(value)) throw new Error('Invalid song MID');
    return value;
  }
  function array(value, name) {
    if (!Array.isArray(value)) throw new Error(`QQ Music missing ${name}`);
    return value;
  }
  function checked(data) {
    if (!data || ['code', 'subcode'].some(k => data[k] != null && Number(data[k]) !== 0)) throw new Error('QQ Music rejected request');
    return data;
  }
  const hasMore = p => p.hasmore === true || Number(p.hasmore) === 1;
  // QQ no longer returns dirType in GetPlaylistByUin; a missing value means an ordinary playlist.
  const editable = p => Number(p.dirId) > 0 && Number(p.dirId) < 200 && Number(p.dirType ?? 0) === 0;
  const asPlaylist = (p, mine = false) => ({ id: String(p.tid || p.dissid || p.id || ''), name: p.dirName || p.title || p.dissname || p.name || '', imageUrl: p.bigpicUrl || p.picUrl || p.picurl || p.coverUrl || p.logo || p.albumPicUrl || '', description: p.desc || '', trackCount: Number(p.songNum || p.songnum || p.song_cnt || p.total_song_num || 0), mine });
  const owned = async s => array((await call(s, 'music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin: s.musicid })).v_playlist, 'playlists');
  async function encrypted(s) {
    if (typeof s.encryptUin === 'string' && s.encryptUin) return s.encryptUin;
    const query = new URLSearchParams({ ct: '20', cv: '4747474', cid: '205360838', userid: s.musicid, format: 'json' });
    const response = await fetchProfile(`https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?${query}`, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`QQ Music profile HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.code !== 0 || body.subcode || typeof body.data?.creator?.encrypt_uin !== 'string' || !body.data.creator.encrypt_uin) throw new Error('QQ Music profile missing encryptUin');
    return body.data.creator.encrypt_uin;
  }
  async function ordinary(s, id) {
    const n = idNumber(id, 'playlist ID');
    const matches = (await owned(s)).filter(p => String(p.tid) === String(n));
    const p = matches[0];
    if (matches.length !== 1 || !Number.isInteger(Number(p.dirId)) || !editable(p) || (p.uin && String(p.uin) !== String(s.musicid))) throw new Error('Only owned ordinary playlists can be edited');
    return { id: n, dir: Number(p.dirId), entry: p };
  }
  async function write(s, module, method, param) {
    const data = await call(s, module, method, param);
    if (!data || data.retCode !== 0 || !data.result || typeof data.result !== 'object') throw new Error(`QQ Music did not confirm ${method}`);
    return data.result;
  }
  function confirm(result, p) {
    if (Number(result.tid) !== p.id || Number(result.dirId) !== p.dir) throw new Error('QQ Music returned inconsistent playlist identity');
  }
  async function songID(s, id) {
    mid(id);
    const data = await call(s, 'music.pf_song_detail_svr', 'get_song_detail_yqq', { song_type: 0, song_mid: id, song_id: '0' });
    const t = data?.track_info;
    if (!t || (t.mid || t.songmid) !== id) throw new Error('QQ Music song identity mismatch');
    return idNumber(t.id || t.songid, 'song ID');
  }
  async function status(s, ids) {
    if (!Array.isArray(ids)) throw new Error('Invalid song IDs');
    ids.forEach(mid);
    if (!ids.length) return {};
    const data = await call(s, 'music.musicasset.SongFavRead', 'IsSongFanByMid', { v_songMid: ids });
    const result = {};
    for (const id of ids) {
      if (typeof data?.m_fan?.[id] !== 'boolean') throw new Error('QQ Music missing liked status');
      result[id] = data.m_fan[id];
    }
    return result;
  }
  const tracks = items => array(items, 'song list').map(item => {
    const track = trackOf(item);
    if (!track.id) throw new Error('QQ Music missing song MID');
    return track;
  });
  function validName(name) {
    if (typeof name !== 'string' || !name.trim() || [...name].length > 20 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Invalid playlist name');
  }
  async function playlists() {
    const s = await account(true);
    if (!s) return [];
    const euin = await encrypted(s);
    const own = (await owned(s)).map(p => asPlaylist(p, editable(p))).filter(p => p.id);
    const saved = [], seen = new Set();
    for (let offset = 0; offset < 10000;) {
      const page = await call(s, 'music.musicasset.PlaylistFavRead', 'CgiGetPlaylistFavInfo', { uin: euin, offset, size: 100 });
      const items = array(page.v_list, 'favorite playlists');
      let fresh = 0;
      for (const item of items) {
        const p = asPlaylist(item);
        if (p.id && !seen.has(p.id)) { seen.add(p.id); saved.push({ ...p, saved: true }); fresh++; }
      }
      if (!hasMore(page)) return [...own, ...saved];
      if (!items.length || !fresh) throw new Error('QQ Music favorite playlists incomplete');
      offset += items.length;
    }
    throw new Error('QQ Music favorite playlists incomplete');
  }
  async function liked({ offset = 0 } = {}) {
    const s = await account(), euin = await encrypted(s);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const page = checked(await call(s, 'music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: 0, dirid: 201, tag: true, song_begin: offset, song_num: 20, userinfo: true, orderlist: true, enc_host_uin: euin }));
    const result = tracks(page.songlist);
    if (hasMore(page) && !result.length) throw new Error('QQ Music liked songs incomplete');
    return { tracks: result, more: hasMore(page) };
  }
  async function playlist({ id }) {
    const pid = idNumber(id, 'playlist ID');
    const s = await account();
    const entry = (await owned(s)).find(p => String(p.tid) === String(pid));
    if (!entry) {
      const body = await cgi('/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', { disstid: pid, type: 1, json: 1, utf8: 1, onlysong: 0, new_format: 1 });
      const info = array(body.cdlist, 'playlist')[0];
      if (!info) throw new Error('QQ Music playlist unavailable');
      return { ...asPlaylist({ ...info, tid: pid }), tracks: tracks(info.songlist) };
    }
    const euin = await encrypted(s), result = [], seen = new Set();
    let first;
    for (let offset = 0; offset < 10000;) {
      const data = checked(await call(s, 'music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: pid, dirid: 0, tag: true, song_begin: offset, song_num: 100, userinfo: true, orderlist: true, enc_host_uin: euin }));
      first ||= data;
      const items = tracks(data.songlist);
      if (!items.length && hasMore(data)) throw new Error('QQ Music playlist incomplete');
      if (items.length && seen.has(items[0].id)) throw new Error('QQ Music playlist paging repeated');
      if (items.length) seen.add(items[0].id);
      result.push(...items);
      const total = Number(data.total_song_num || 0);
      if (!hasMore(data) && (total === 0 || result.length >= total)) return { ...asPlaylist({ ...(first.dirinfo || {}), tid: pid, total_song_num: first.total_song_num }, editable(entry)), tracks: result };
      if (!items.length) throw new Error('QQ Music playlist incomplete');
      offset += items.length;
    }
    throw new Error('QQ Music playlist incomplete');
  }
  async function isLiked({ ids }) {
    if (!Array.isArray(ids)) throw new Error('Invalid song IDs');
    const s = await account(true);
    if (!s) return Object.fromEntries(ids.map(id => [id, false]));
    return status(s, ids);
  }
  async function like({ id, on }) {
    const s = await account(); mid(id);
    if (typeof on !== 'boolean') throw new Error('Invalid liked state');
    if ((await status(s, [id]))[id] === on) return;
    const numeric = await songID(s, id);
    await write(s, 'music.musicasset.PlaylistDetailWrite', on ? 'AddSonglist' : 'DelSonglist', { dirId: 201, v_songInfo: [{ songId: numeric, songType: 0 }] });
    if ((await status(s, [id]))[id] !== on) throw new Error('QQ Music did not confirm liked state');
  }
  async function createPlaylist({ name }) {
    const s = await account(); validName(name);
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'AddPlaylist', { dirName: name });
    const p = await ordinary(s, idNumber(result.tid, 'playlist ID'));
    if (p.dir !== Number(result.dirId)) throw new Error('QQ Music returned inconsistent new playlist');
    return asPlaylist(p.entry, true);
  }
  async function renamePlaylist({ id, name }) {
    const s = await account(); validName(name);
    const p = await ordinary(s, id);
    const read = async () => {
      const data = checked(await call(s, 'music.srfDissInfo.aiDissInfo', 'uniform_get_Dissinfo', { dirid: p.dir, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 }));
      const info = data.dirinfo;
      if (!info || Number(info.dirid) !== p.dir || ['title', 'desc', 'picurl', 'picurl2'].some(k => typeof info[k] !== 'string') || !Array.isArray(info.tag) || info.tag.length > 3 || ![1, 2].includes(Number(info.dir_show)) || info.picurl2) throw new Error('QQ Music playlist settings incomplete');
      return info;
    };
    const before = await read();
    const tags = before.tag.map(t => idNumber(t.id, 'tag ID'));
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'EditPlaylist', { dirId: p.dir, mask: 95, dirNewName: name, dirNewDesc: before.desc, dirNewPicUrl: before.picurl, dirNewPicUrl2: '', dirNewtaglist: tags.join(','), dirShow: Number(before.dir_show) });
    confirm(result, p);
    const after = await read();
    if (after.title !== name || after.desc !== before.desc || after.picurl !== before.picurl || Number(after.dir_show) !== Number(before.dir_show)) throw new Error('QQ Music did not confirm playlist settings');
  }
  async function deletePlaylist({ id }) {
    const s = await account(), p = await ordinary(s, id);
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'DelPlaylist', { dirId: p.dir });
    confirm(result, p);
    if (Number(result.updateTime) !== 0 || (await owned(s)).some(x => String(x.tid) === String(p.id) || Number(x.dirId) === p.dir)) throw new Error('QQ Music did not confirm playlist deletion');
  }
  async function editSongs({ id, trackIds }, add) {
    const s = await account();
    if (!Array.isArray(trackIds) || !trackIds.length || trackIds.length > 100) throw new Error('Select 1-100 songs');
    trackIds.forEach(mid);
    const p = await ordinary(s, id);
    const songIds = await Promise.all(trackIds.map(song => songID(s, song)));
    const result = await write(s, 'music.musicasset.PlaylistDetailWrite', add ? 'AddSonglist' : 'DelSonglist', { dirId: p.dir, v_songInfo: songIds.map(songId => ({ songId, songType: 0 })) });
    confirm(result, p);
  }
  async function savedAlbums({ offset = 0 } = {}) {
    const s = await account();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    if (typeof qqAuthCgi !== 'function') throw new Error('Authenticated QQ Music CGI is required');
    const body = checked(await qqAuthCgi('/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', { ct: 20, cid: 205360956, userid: s.musicid, reqtype: 2, sin: offset, ein: offset + 19 }, s));
    const data = body.data;
    if (!data || !Number.isSafeInteger(data.totalalbum) || data.totalalbum < 0) throw new Error('QQ Music missing saved album total');
    const entries = array(data.albumlist, 'saved albums');
    if (!entries.length && offset < data.totalalbum) throw new Error('QQ Music saved albums incomplete');
    const albums = entries.map(a => {
      if (!a || typeof a !== 'object') throw new Error('QQ Music invalid saved album');
      const id = a.albummid || a.album_mid || a.albumMid || a.albumMID || a.mid;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(id)) throw new Error('QQ Music missing album MID');
      const singers = a.singers || a.singer;
      const artists = Array.isArray(singers) ? singers.map(x => ({ id: String(x.mid || x.singermid || ''), name: String(x.name || x.singername || '') })) : [];
      if (!artists.length && (a.singerName || a.singername || a.singer_name)) artists.push({ id: String(a.singermid || a.singerMid || a.singer_mid || ''), name: String(a.singerName || a.singername || a.singer_name) });
      return { id, name: String(a.albumname || a.album_name || a.albumName || a.name || a.title || ''), imageUrl: String(a.picurl || a.picUrl || a.albumPicUrl || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${id}.jpg`), artists, released: releasedOf(a.release_time ?? a.publishDate ?? a.pubtime) };
    });
    return { albums, more: offset + albums.length < data.totalalbum };
  }
  async function saveAlbum({ id, on }) {
    const s = await account();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(id)) throw new Error('Invalid album MID');
    if (typeof on !== 'boolean') throw new Error('Invalid album saved state');
    const numericOwner = Number(s.musicid);
    if (!/[1-9]/.test(s.musicid)) throw new Error('Invalid account ID');
    const owner = Number.isSafeInteger(numericOwner) ? numericOwner : s.musicid;
    const read = async () => {
      const data = await call(s, 'music.musicasset.AlbumFavRead', 'IsAlbumFan', { uin: owner, v_albumMid: [id] });
      if (typeof data?.m_fan?.[id] !== 'boolean') throw new Error('QQ Music missing album saved status');
      return data.m_fan[id];
    };
    if (await read() === on) return;
    const data = await call(s, 'music.musicasset.AlbumFavWrite', on ? 'FavAlbum' : 'CancelFavAlbum', { uin: s.musicid, v_albumMid: [id] });
    if (!data || data.result !== 0 || !Array.isArray(data.v_failedAlbumId) || !Array.isArray(data.v_failedAlbumMid) || data.v_failedAlbumId.length || data.v_failedAlbumMid.length) throw new Error('QQ Music did not confirm album change');
    if (await read() !== on) throw new Error('QQ Music did not confirm album saved state');
  }
  return { playlists, playlist, liked, isLiked, like, savedAlbums, saveAlbum, createPlaylist, renamePlaylist, deletePlaylist,
    addToPlaylist: args => editSongs(args, true), removeFromPlaylist: args => editSongs(args, false) };
}

const qqLibrary = createLibrary({ qqAuthRpc, qqReadSession, qqAuthCgi: cgi, cgi, trackOf });
export const playlists = qqLibrary.playlists;
export const liked = qqLibrary.liked;
export const isLiked = qqLibrary.isLiked;
export const like = qqLibrary.like;
export const savedAlbums = qqLibrary.savedAlbums;
export const saveAlbum = qqLibrary.saveAlbum;
export const createPlaylist = qqLibrary.createPlaylist;
export const renamePlaylist = qqLibrary.renamePlaylist;
export const deletePlaylist = qqLibrary.deletePlaylist;
export const addToPlaylist = qqLibrary.addToPlaylist;
export const removeFromPlaylist = qqLibrary.removeFromPlaylist;
export async function playlist({ id }) {
  if (id.startsWith("chart:") || !qqReadSession()) return qqBrowse.playlist({ id });
  return qqLibrary.playlist({ id });
}

export { decodeQRC };
