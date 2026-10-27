/**
 * Steam Web API 薄封装。配了 apiKey 才用,除了全球成就完成率(公开接口,不需要 key)。
 *
 * 用途:补未安装游戏的名字、最近两周时长、成就定义/解锁状态/稀有度、好友在线。
 * 文档:https://steamcommunity.com/dev/apikey 申请,https://developer.valvesoftware.com/wiki/Steam_Web_API
 */

import { httpRequest } from './http.ts';

export interface WebApiConfig {
  apiKey: string;
  steamId: string;
  timeoutMs: number;
}

export interface OwnedGame {
  appid: string;
  name: string;
  playtimeForever: number;
  lastPlayed: number;
}

/** 最近两周玩过的(Steam 只有这个固定窗口,不能自选天数)。 */
export interface RecentGame {
  appid: string;
  name: string;
  playtimeTwoWeeks: number;
  playtimeForever: number;
  lastPlayed: number;
}

export interface AchievementDef {
  /** API 里的名字,和完成率表对得上 */
  apiName: string;
  name: string;
  description: string;
  hidden: boolean;
}

export interface PlayerAchievement {
  apiName: string;
  achieved: boolean;
  /** 解锁时间(epoch ms);0=没解锁 */
  unlockTime: number;
}

/** 玩家档案/在线状态;好友列表里的每一项也是这个形状。 */
export interface PlayerSummary {
  steamId: string;
  name: string;
  /** 真实名,没公开就是空串 */
  realName: string;
  profileUrl: string;
  avatar: string;
  /** 资料可见性:公开 / 仅好友 / 私密 / 未知 */
  visibility: string;
  /** 人话状态:在线 / 离线 / 离开 … */
  state: string;
  /** 正在玩的游戏名,没在玩就是空串 */
  gameName: string;
  /** 上次下线(epoch ms),在线时为 0 */
  lastLogOff: number;
  /** 注册时间(epoch ms),0=没给 */
  createdAt: number;
  /** ISO 国家/地区码,没公开就是空串 */
  countryCode: string;
}

const BASE = 'https://api.steampowered.com';
/** 一次 GetPlayerSummaries 最多问 100 个 steamid。 */
const SUMMARY_BATCH = 100;
/** 好友太多时只查前面这些,避免真的发几十个请求。 */
const FRIEND_LIMIT = 300;

const STATE_TEXT: Record<number, string> = { 0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏' };

/** 请求一次;网络抖动或超时再试一次(HTTP 4xx 不重试,那是权限/参数问题)。 */
async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const budget = timeoutMs || 12000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await httpRequest(url, { timeoutMs: budget });
    if (result) {
      if (!result.ok) return null;
      try {
        return JSON.parse(result.text) as T;
      } catch {
        return null;
      }
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

function keyed(path: string, cfg: WebApiConfig, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ key: cfg.apiKey });
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return `${BASE}${path}?${params.toString()}&format=json`;
}

/**
 * 探一下这把 key 到底能不能用。失败时用来区分「key 被拒」和「这游戏没数据」,
 * 免得把 403 说成「没有成就定义」。
 *  - ok         key 有效,能读到这个玩家
 *  - denied     key 无效/被撤销(401/403)
 *  - no-player  key 有效,但查不到这个 SteamID64(账号 ID 不对或资料不公开)
 *  - unknown    网络失败或返回看不懂
 */
export type KeyProbe = 'ok' | 'denied' | 'no-player' | 'unknown';

export async function probeApiKey(cfg: WebApiConfig): Promise<KeyProbe> {
  if (!cfg.apiKey || !cfg.steamId) return 'unknown';
  const url = keyed('/ISteamUser/GetPlayerSummaries/v2/', cfg, { steamids: cfg.steamId });
  // 和其他请求走同一条网络出口:用户配了代理就得走代理。
  // 走裸 fetch 会绕过代理设置,直连超时被误报成「key 有问题」。
  const result = await httpRequest(url, { timeoutMs: cfg.timeoutMs || 12000 });
  if (!result) return 'unknown';
  if (result.status === 401 || result.status === 403) return 'denied';
  if (!result.ok) return 'unknown';
  try {
    const data = JSON.parse(result.text) as { response?: { players?: unknown[] } };
    const players = data?.response?.players;
    if (!Array.isArray(players)) return 'unknown';
    return players.length > 0 ? 'ok' : 'no-player';
  } catch {
    return 'unknown';
  }
}

/** 拿这个账号拥有的游戏(含名字与总时长)。需要 key。 */
export async function fetchOwnedGames(cfg: WebApiConfig): Promise<OwnedGame[] | null> {
  if (!cfg.apiKey || !cfg.steamId) return null;
  const url = keyed('/IPlayerService/GetOwnedGames/v1/', cfg, {
    steamid: cfg.steamId,
    include_appinfo: 1,
    include_played_free_games: 1,
  });
  const data = await getJson<{
    response?: { games?: Array<{ appid: number; name?: string; playtime_forever?: number; rtime_last_played?: number }> };
  }>(url, cfg.timeoutMs);
  if (!data?.response?.games) return null;
  return data.response.games.map((game) => ({
    appid: String(game.appid),
    name: game.name ?? '',
    playtimeForever: Number(game.playtime_forever ?? 0),
    lastPlayed: Number(game.rtime_last_played ?? 0) * 1000,
  }));
}

/** 最近两周玩过的游戏(含两周时长)。需要 key。窗口固定 14 天,不能自己选。 */
export async function fetchRecentlyPlayed(cfg: WebApiConfig): Promise<RecentGame[] | null> {
  if (!cfg.apiKey || !cfg.steamId) return null;
  const url = keyed('/IPlayerService/GetRecentlyPlayedGames/v1/', cfg, { steamid: cfg.steamId, count: 0 });
  const data = await getJson<{
    response?: {
      total_count?: number;
      games?: Array<{ appid: number; name?: string; playtime_2weeks?: number; playtime_forever?: number; rtime_last_played?: number }>;
    };
  }>(url, cfg.timeoutMs);
  const games = data?.response?.games;
  if (!Array.isArray(games)) return null;
  return games.map((game) => ({
    appid: String(game.appid),
    name: game.name ?? '',
    playtimeTwoWeeks: Number(game.playtime_2weeks ?? 0),
    playtimeForever: Number(game.playtime_forever ?? 0),
    lastPlayed: Number(game.rtime_last_played ?? 0) * 1000,
  }));
}

/** 某款游戏的成就定义。需要 key。 */
export async function fetchAchievementSchema(cfg: WebApiConfig, appid: string): Promise<AchievementDef[] | null> {
  if (!cfg.apiKey) return null;
  const url = keyed('/ISteamUserStats/GetSchemaForGame/v2/', cfg, { appid });
  const data = await getJson<{
    game?: { availableGameStats?: { achievements?: Array<{ name?: string; displayName?: string; description?: string; hidden?: number }> } };
  }>(url, cfg.timeoutMs);
  const list = data?.game?.availableGameStats?.achievements;
  if (!Array.isArray(list)) return null;
  return list.map((item) => ({
    apiName: item.name ?? '',
    name: item.displayName || item.name || '',
    description: item.description ?? '',
    hidden: Number(item.hidden ?? 0) === 1,
  }));
}

/** 这个账号在某款游戏里解锁了哪些成就。需要 key。游戏没有统计数据时返回 null。 */
export async function fetchPlayerAchievements(cfg: WebApiConfig, appid: string): Promise<PlayerAchievement[] | null> {
  if (!cfg.apiKey || !cfg.steamId) return null;
  const url = keyed('/ISteamUserStats/GetPlayerAchievements/v1/', cfg, { appid, steamid: cfg.steamId, l: 'schinese' });
  const data = await getJson<{
    playerstats?: { success?: boolean; achievements?: Array<{ apiname?: string; achieved?: number; unlocktime?: number }> };
  }>(url, cfg.timeoutMs);
  const list = data?.playerstats?.achievements;
  if (!Array.isArray(list)) return null;
  return list.map((item) => ({
    apiName: item.apiname ?? '',
    achieved: Number(item.achieved ?? 0) === 1,
    unlockTime: Number(item.unlocktime ?? 0) * 1000,
  }));
}

/**
 * 全服成就完成率(百分比)。**不需要 key**,公开接口。
 * 返回 apiName → percent;拿不到返回 null(新游戏、或没开成就的游戏常常没有)。
 */
export async function fetchGlobalAchievementPercents(appid: string, timeoutMs = 12000): Promise<Map<string, number> | null> {
  const url = `${BASE}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(appid)}&format=json`;
  const data = await getJson<{ achievementpercentages?: { achievements?: Array<{ name?: string; percent?: number }> } }>(url, timeoutMs);
  const list = data?.achievementpercentages?.achievements;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, number>();
  for (const item of list) {
    if (item.name) out.set(item.name, Number(item.percent ?? 0));
  }
  return out;
}

/** 好友的 steamid 列表。需要 key,且账号的好友列表必须公开;不公开返回 null。 */export async function fetchFriendIds(cfg: WebApiConfig): Promise<string[] | null> {
  if (!cfg.apiKey || !cfg.steamId) return null;
  const url = keyed('/ISteamUser/GetFriendList/v1/', cfg, { steamid: cfg.steamId, relationship: 'friend' });
  const data = await getJson<{ friendslist?: { friends?: Array<{ steamid?: string }> } }>(url, cfg.timeoutMs);
  const list = data?.friendslist?.friends;
  if (!Array.isArray(list)) return null;
  return list.map((item) => item.steamid ?? '').filter(Boolean).slice(0, FRIEND_LIMIT);
}

/** 资料可见性:1 私密 / 2 仅好友 / 3 公开。 */
const VISIBILITY_TEXT: Record<number, string> = { 1: '私密', 2: '仅好友', 3: '公开' };

interface RawPlayer {
  steamid: string;
  personaname?: string;
  realname?: string;
  profileurl?: string;
  avatarfull?: string;
  personastate?: number;
  communityvisibilitystate?: number;
  gameextrainfo?: string;
  lastlogoff?: number;
  timecreated?: number;
  loccountrycode?: string;
}

function toSummary(player: RawPlayer): PlayerSummary {
  const state = Number(player.personastate ?? 0);
  return {
    steamId: player.steamid,
    name: player.personaname ?? '',
    realName: player.realname ?? '',
    profileUrl: player.profileurl ?? '',
    avatar: player.avatarfull ?? '',
    visibility: VISIBILITY_TEXT[Number(player.communityvisibilitystate ?? 0)] ?? '未知',
    state: STATE_TEXT[state] ?? '未知',
    gameName: player.gameextrainfo ?? '',
    lastLogOff: Number(player.lastlogoff ?? 0) * 1000,
    createdAt: Number(player.timecreated ?? 0) * 1000,
    countryCode: player.loccountrycode ?? '',
  };
}

/** 批量拿玩家摘要(昵称、状态、在玩什么、资料可见性)。需要 key;内部按 100 个一批。 */
export async function fetchPlayerSummaries(cfg: WebApiConfig, steamIds: string[]): Promise<PlayerSummary[] | null> {
  if (!cfg.apiKey || steamIds.length === 0) return null;
  const out: PlayerSummary[] = [];
  for (let i = 0; i < steamIds.length; i += SUMMARY_BATCH) {
    const batch = steamIds.slice(i, i + SUMMARY_BATCH);
    const url = keyed('/ISteamUser/GetPlayerSummaries/v2/', cfg, { steamids: batch.join(',') });
    const data = await getJson<{ response?: { players?: RawPlayer[] } }>(url, cfg.timeoutMs);
    const players = data?.response?.players;
    if (!Array.isArray(players)) return out.length > 0 ? out : null;
    for (const player of players) out.push(toSummary(player));
  }
  return out;
}

/** 拿当前账号自己的档案。需要 key。 */
export async function fetchOwnProfile(cfg: WebApiConfig): Promise<PlayerSummary | null> {
  if (!cfg.apiKey || !cfg.steamId) return null;
  const list = await fetchPlayerSummaries(cfg, [cfg.steamId]);
  return list?.[0] ?? null;
}
