/**
 * Steam World:让 bot 知道使用者在玩什么、玩了多少、库里有什么、成就推到哪了。
 *
 * 数据分两层:
 *  - 本地(localconfig.vdf + appmanifest + achievement_progress.json):不需要 key,
 *    有准确 appid、累计时长、最后游玩、已安装列表、成就进度。
 *  - Web API(可选):补未安装游戏的名字、最近两周时长、成就详情与稀有度、好友在线。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import type { SteamConfigSection } from './config.ts';
import { crossCheck, type CrossCheck, type Verdict } from './cross-check.ts';
import {
  fetchAchievementSchema,
  fetchFriendIds,
  fetchGlobalAchievementPercents,
  fetchOwnedGames,
  fetchOwnProfile,
  fetchPlayerAchievements,
  fetchPlayerSummaries,
  fetchRecentlyPlayed,
  probeApiKey,
  type KeyProbe,
  type OwnedGame,
  type WebApiConfig,
} from './steam-api.ts';
import {
  detectSteamId,
  detectSteamPath,
  parsePlaytimes,
  readAchievements,
  readGameAchievements,
  readInstalled,
  readLoginUsers,
  readRegistry,
  readScreenshots,
  toAccountId,
  toSteamId64,
  type AppRecord,
  type GameAchievements,
  type RunningState,
  type SteamConfig,
} from './steam-local.ts';
import {
  PriceCache,
  CURRENT_TTL_MS,
  HISTORY_TTL_MS,
  fetchSteamPrice,
  formatAmount,
  formatMinor,
  itadLookup,
  itadPrices,
  searchSteamAppId,
  storeCooldownLeft,
  type SteamPriceResult,
} from './price.ts';
import { httpStatus, setProxy } from './http.ts';
import { fmtDateTime, parsePoint } from './time.ts';

export interface ToolDeps {
  cfg: () => SteamConfigSection;
  timezone: string;
  /** ITAD API key;没配就是空串,价格工具会退化成只报现价 */
  itadKey?: () => string;
  /** 价格缓存落盘目录(World 的 dataDir) */
  dataDir?: string;
  /** 上次看到的 appid,用来判断「刚开游戏」 */
  onSeen?: (appid: string) => void;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function localConfig(cfg: SteamConfigSection): SteamConfig {
  return {
    steamPath: (cfg.steamPath ?? '').trim(),
    steamId: (cfg.steamId ?? '').trim(),
    apiKey: (cfg.apiKey ?? '').trim(),
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 12000,
  };
}

function webConfig(cfg: SteamConfigSection, steamId: string): WebApiConfig {
  return {
    apiKey: (cfg.apiKey ?? '').trim(),
    steamId,
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 12000,
  };
}

interface Library {
  steamPath: string;
  /** 32 位账号 ID:userdata / localconfig / 截图都用它 */
  accountId: string;
  /** 64 位 SteamID:Web API 用它,拿不到就是空串 */
  steamId64: string;
  running: RunningState;
  apps: AppRecord[];
  byId: Map<string, AppRecord>;
  hasApiKey: boolean;
  /** 本地没名字时,API 能补上的数量 */
  missingNames: number;
}

/** GetOwnedGames 的结果缓存 10 分钟:每次工具调用都重新问一遍太浪费,库也不会秒变。 */
const OWNED_TTL_MS = 10 * 60_000;
let ownedCache: { at: number; steamId: string; games: OwnedGame[] } | null = null;

async function ownedGames(cfg: SteamConfigSection, steamId: string): Promise<OwnedGame[] | null> {
  if (ownedCache && ownedCache.steamId === steamId && Date.now() - ownedCache.at < OWNED_TTL_MS) return ownedCache.games;
  const games = await fetchOwnedGames(webConfig(cfg, steamId));
  if (games) ownedCache = { at: Date.now(), steamId, games };
  return games;
}

/** key 能不能用,缓存 5 分钟;只在需要解释失败原因时探。 */
const KEY_STATE_TTL_MS = 5 * 60_000;
let keyStateCache: { at: number; steamId64: string; state: KeyProbe } | null = null;

async function apiKeyState(cfg: SteamConfigSection, steamId64: string): Promise<KeyProbe> {
  if (!steamId64) return 'unknown';
  if (keyStateCache && keyStateCache.steamId64 === steamId64 && Date.now() - keyStateCache.at < KEY_STATE_TTL_MS) {
    return keyStateCache.state;
  }
  const state = await probeApiKey(webConfig(cfg, steamId64));
  keyStateCache = { at: Date.now(), steamId64, state };
  return state;
}

/** 汇总一份库快照;每次都重读本地文件(文件不大),只有 Web API 那份走缓存。 */
async function loadLibrary(cfg: SteamConfigSection): Promise<Library> {
  const local = localConfig(cfg);
  const steamPath = detectSteamPath(local);
  if (!steamPath || !existsSync(steamPath)) {
    throw new Error(
      `找不到 Steam 安装目录(${local.steamPath || '自动探测失败'})。在 worlds.steam.steamPath 里填一下,例如 D:\\Steam。`,
    );
  }
  const accountId = toAccountId(detectSteamId(local, steamPath));
  const steamId64 = toSteamId64(accountId);
  const running = readRegistry();

  const installed = readInstalled(steamPath);
  const playtimes = new Map<string, { playtime: number; lastPlayed: number }>();
  if (accountId) {
    const file = join(steamPath, 'userdata', accountId, 'config', 'localconfig.vdf');
    if (existsSync(file)) {
      try {
        for (const [id, value] of parsePlaytimes(readFileSync(file, 'utf8'))) playtimes.set(id, value);
      } catch {
        // 解析失败就当没有游玩记录
      }
    }
  }
  const achievements = readAchievements(steamPath, accountId);

  const apps: AppRecord[] = [];
  const seen = new Set<string>();
  for (const [appid, info] of installed) {
    seen.add(appid);
    apps.push({
      appid,
      name: info.name,
      playtime: playtimes.get(appid)?.playtime ?? 0,
      lastPlayed: playtimes.get(appid)?.lastPlayed ?? 0,
      installed: true,
      ...(achievements.get(appid) ? { achievements: achievements.get(appid) } : {}),
    });
  }
  for (const [appid, value] of playtimes) {
    if (seen.has(appid)) continue;
    apps.push({
      appid,
      name: '',
      playtime: value.playtime,
      lastPlayed: value.lastPlayed,
      installed: false,
      ...(achievements.get(appid) ? { achievements: achievements.get(appid) } : {}),
    });
  }

  const hasApiKey = Boolean(local.apiKey);
  // 有 key 就补名字(只对本地缺名字的补,省流量;Web API 要 64 位 ID)
  const missing = apps.filter((app) => !app.name);
  if (hasApiKey && steamId64 && missing.length > 0) {
    const owned = await ownedGames(cfg, steamId64);
    if (owned) {
      const nameById = new Map(owned.map((game) => [game.appid, game]));
      for (const app of missing) {
        const hit = nameById.get(app.appid);
        if (hit?.name) {
          app.name = hit.name;
          if (!app.playtime) app.playtime = hit.playtimeForever;
          if (!app.lastPlayed) app.lastPlayed = hit.lastPlayed;
        }
      }
    }
  }

  const byId = new Map(apps.map((app) => [app.appid, app]));
  return {
    steamPath,
    accountId,
    steamId64,
    running,
    apps,
    byId,
    hasApiKey,
    missingNames: apps.filter((app) => !app.name).length,
  };
}

/**
 * 按名字找游戏:先匹配本地(快),匹配不到再问一次 Steam 商店。
 * 本地名字是 appmanifest 里的英文名,而用户大概率用中文名问。
 */
async function resolveApps(cfg: SteamConfigSection, library: Library, query: string): Promise<AppRecord[]> {
  const local = findApps(library, query);
  if (local.length > 0) return local;
  if (/^\d{2,8}$/.test(query)) {
    const app = library.byId.get(query);
    return app ? [app] : [];
  }
  const found = await searchSteamAppId(query, ((cfg.priceCountry ?? 'CN').trim() || 'CN').toLowerCase());
  if (found.kind !== 'ok') return [];
  const known = library.byId.get(found.appid);
  if (known) return [known];
  // 库里没有这款(或者名字对不上):用商店返回的名字造一条,够展示用
  return [{ appid: found.appid, name: found.name, playtime: 0, lastPlayed: 0, installed: false }];
}

/**
 * 单款成就:优先读 `librarycache/<appid>.json`(最准,带每条名字),
 * 读不到再退回 achievement_progress.json 索引里的数字(只有计数,没有条目)。
 */
function gameAchievements(library: Library, appid: string): GameAchievements | null {
  const detail = readGameAchievements(library.steamPath, library.accountId, appid);
  if (detail) return detail;
  const basic = library.byId.get(appid)?.achievements;
  return basic ? { ...basic, items: [] } : null;
}

function appLabel(app: AppRecord | undefined, appid: string): string {
  if (!app) return `appid ${appid}`;
  return app.name ? `${app.name}(${appid})` : `appid ${appid}`;
}

/** 按名字或 appid 找游戏。 */
function findApps(library: Library, query: string): AppRecord[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return [];
  const byId = library.apps.filter((app) => app.appid === lower);
  if (byId.length) return byId;
  return library.apps.filter((app) => app.name && app.name.toLowerCase().includes(lower));
}

function hours(minutes: number): string {
  if (minutes <= 0) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.round((minutes / 60) * 10) / 10} 小时`;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  confirmed: '确实在玩',
  likely: '大概在玩',
  stale: '看着像在玩,其实已经退了',
  outside: '有游戏在跑,但不是 Steam 启动的',
  idle: '没在玩',
};

function verdictTag(check: CrossCheck): string {
  const icon = check.verdict === 'confirmed' ? '✅' : check.verdict === 'likely' ? '🟡' : check.verdict === 'outside' ? '🔵' : '⚪';
  return `${icon} ${VERDICT_TEXT[check.verdict]}`;
}

/**
 * 真的缺哪几个成就:成就定义 − 已解锁,隐藏成就跳过(别剧透),
 * 按全服完成率从稀到常见排。完成率是公开接口,不需要 key;解锁状态要 key。
 */
async function achievementGaps(
  cfg: SteamConfigSection,
  steamId: string,
  appid: string,
  limit = 10,
): Promise<string[]> {
  const web = webConfig(cfg, steamId);
  const [schema, mine, rarity] = await Promise.all([
    fetchAchievementSchema(web, appid),
    fetchPlayerAchievements(web, appid),
    fetchGlobalAchievementPercents(appid),
  ]);
  if (!schema || schema.length === 0 || !mine) {
    // 先确认是不是 key 的问题,别把 403 说成「这游戏没成就」
    const state = await apiKeyState(cfg, steamId);
    if (state === 'denied') return ['  (Steam 拒绝了这把 API key:401/403,去 steamcommunity.com/dev/apikey 重新签一把)'];
    if (state === 'no-player') return ['  (key 能用,但查不到这个 SteamID64 的玩家:检查账号 ID,或把「游戏详情」设为公开)'];
  }
  if (!schema || schema.length === 0) {
    return ['  (Steam 没返回成就定义:可能这游戏没有成就,也可能刚才请求超时或被限流,过一会儿再试)'];
  }
  if (!mine) return ['  (Steam 没给出你的解锁记录:可能这游戏没开统计,或账号的「游戏详情」不是公开的)'];

  const unlocked = new Set(mine.filter((item) => item.achieved).map((item) => item.apiName));
  const missing = schema
    .filter((item) => item.apiName && !unlocked.has(item.apiName) && !item.hidden)
    .map((item) => ({ ...item, percent: rarity?.get(item.apiName) }));
  if (missing.length === 0) return ['  🎉 全成就,一个不剩'];

  missing.sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101));
  const known = missing.some((item) => item.percent !== undefined);
  const lines = [`  还差 ${missing.length} 个${known ? ',从全服最稀有的开始' : ''}:`];
  for (const item of missing.slice(0, limit)) {
    const rare = item.percent !== undefined ? `(全服 ${item.percent.toFixed(1)}%)` : '';
    lines.push(`    · ${item.name}${rare}${item.description ? ` — ${item.description}` : ''}`);
  }
  if (missing.length > limit) lines.push(`    …还有 ${missing.length - limit} 个`);
  return lines;
}

const NO_KEY_MISSING = '  (要逐条列缺哪些成就,需要配 Steam Web API key)';

/** 同一个 dataDir 共用一个缓存实例(steamTools 可能被多次构造)。 */
const priceCaches = new Map<string, PriceCache>();

function priceCacheFor(dataDir: string | undefined): PriceCache {
  const key = dataDir ?? '';
  let cache = priceCaches.get(key);
  if (!cache) {
    cache = PriceCache.inDir(key);
    priceCaches.set(key, cache);
  }
  return cache;
}

function minutesAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}


export const STEAM_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'steam_now',
    tags: ['read'],
    description:
      'Report what the person is playing on Steam right now: the game name, their total hours and achievement progress, plus a verdict saying how sure the evidence is. Returns "not playing" when nothing is running. Use it when the user asks "我在玩什么" or when you want to comment on their gaming.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'steam_profile',
    tags: ['read'],
    description:
      'Report the Steam account this machine is signed in to: display name, SteamID64, online state, what they are playing, profile visibility, account creation date and the profile URL. The display name works offline from the local client; everything else needs an API key. Use it when the user asks "你知道我的 Steam 叫什么吗" or anything about their own account.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'steam_playtime',
    tags: ['read'],
    description:
      'Report playtime for one or more games: total hours, last played date, and whether installed. Accepts a game name fragment or an appid; empty lists the most-played games. Use it for "我玩了多久X" or "我玩得最多的游戏".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '游戏名片段或 appid,多个用逗号分隔。留空=按总时长排前几名。' },
        top: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '留空 query 时列几款。' },
        since: {
          type: 'string',
          description: '可选。只看这个时间之后玩过的:"YYYY-MM-DD"、"HH:mm",或 "7d" / "12h" / "2w" 这种相对写法(从现在往回数)。',
        },
      },
    },
  },
  {
    name: 'steam_library',
    tags: ['read'],
    description:
      'List the Steam library: installed games, games with playtime, or ones never touched. Use it for "我库里有什么" or "有什么我没玩过的".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: {
          type: 'string',
          enum: ['installed', 'played', 'untouched', 'all'],
          default: 'installed',
          description: 'installed=已安装、played=有游玩记录、untouched=一次没玩过、all=全部。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
    },
  },
  {
    name: 'steam_achievements',
    tags: ['read'],
    description:
      'Report achievement progress: overall completion, or one game\'s unlocked/total. With show_missing it names the achievements still locked (requires an API key) and marks how rare each one is globally. Use it for "我成就怎么样", "X 的成就打到哪了" or "我还差哪几个成就".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '游戏名片段或 appid;留空=给整体统计 + 进度最高的几款。' },
        show_missing: {
          type: 'boolean',
          default: false,
          description: 'true 时逐条列出还没拿到的成就名与全服完成率(要 API key;隐藏成就不会列出,避免剧透)。',
        },
      },
    },
  },
  {
    name: 'steam_recent',
    tags: ['read'],
    description:
      'Report what was played in the last two weeks: Steam only offers a fixed 14-day window. With an API key it also gives the minutes played in that window; without one it falls back to local last-played dates. Use it for "我最近在玩什么" or "这两周玩了多久".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '最多列几款。' },
      },
    },
  },
  {
    name: 'steam_price',
    tags: ['read'],
    description:
      'Look up what a game costs in the user region: the current Steam price and discount, plus the historical low for the same region from IsThereAnyDeal (needs the free ITAD API key; without it only the current price is reported). Accepts a game name or an appid, and works for games that are not in the library. Use it when the user asks "这个多少钱", "现在打折吗", "史低多少" or whether it is worth buying now.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '游戏名或 appid。库里没有的会先去 Steam 商店搜。' },
        refresh: { type: 'boolean', default: false, description: 'true=绕过本地价格缓存,现拉一次。' },
      },
    },
  },
  {
    name: 'steam_friends',
    tags: ['read'],
    description:
      'Report which Steam friends are online and what they are playing, by default only those currently online. Off unless the user enabled it in the config; requires an API key and a public friends list. Use it only when the user asks about friends — never volunteer it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        only_online: { type: 'boolean', default: true, description: 'true=只列在线/游戏中的;false=连离线的也列。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '最多列几个人。' },
      },
    },
  },
  {
    name: 'steam_status',
    tags: ['read'],
    description:
      'Report the Steam integration state: install path, account, whether an API key is configured, whether the friends switch is on, how many games were found, how many still lack names. Use it when something looks wrong or the user asks whether it works.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export function steamTools(deps: ToolDeps): ToolDef[] {
  const handlers: Record<string, ToolDef['handler']> = {
    steam_profile: async () => {
      try {
        const cfg = deps.cfg();
        const local = localConfig(cfg);
        const steamPath = detectSteamPath(local);
        if (!steamPath || !existsSync(steamPath)) {
          return `找不到 Steam 安装目录(${local.steamPath || '自动探测失败'})。在 worlds.steam.steamPath 里填一下。`;
        }

        // 本地这份不需要 key:config/loginusers.vdf 里就有 SteamID64 与昵称
        const accountId = toAccountId(detectSteamId(local, steamPath));
        const derived = toSteamId64(accountId);
        const users = readLoginUsers(steamPath);
        const localUser = users.find((item) => item.steamId64 === derived)
          ?? [...users].sort((a, b) => b.lastLogin - a.lastLogin)[0];
        const steamId64 = derived || localUser?.steamId64 || '';

        if (!local.apiKey || !steamId64) {
          const lines: string[] = [];
          if (localUser?.personaName) lines.push(`昵称:${localUser.personaName}`);
          if (steamId64 || localUser?.steamId64) lines.push(`SteamID64:${steamId64 || localUser?.steamId64}`);
          if (localUser?.lastLogin) lines.push(`本机最近登录:${fmtDateTime(localUser.lastLogin, deps.timezone).slice(0, 16)}`);
          if (lines.length === 0) return '读不到本机登录的 Steam 账号(config/loginusers.vdf 里没有记录)。';
          lines.push('(昵称是本机 config/loginusers.vdf 里读的;在线状态、当前在玩、资料可见性、注册时间要 Steam Web API key)');
          return lines.join('\n');
        }

        const profile = await fetchOwnProfile(webConfig(cfg, steamId64));
        if (!profile) {
          const state = await apiKeyState(cfg, steamId64);
          if (state === 'denied') return 'Steam 拒绝了这把 API key(401/403),档案查不到;去 steamcommunity.com/dev/apikey 重新签一把。';
          if (state === 'no-player') return `查不到 SteamID64 ${steamId64} 对应的玩家:检查账号 ID,或把 Steam 个人资料设为公开。`;
          return 'Steam 没返回档案(可能是网络问题),过一会儿再试。';
        }

        const lines = [
          `昵称:${profile.name || localUser?.personaName || '未知'}`,
          `SteamID64:${profile.steamId}`,
          `当前状态:${profile.gameName ? `游戏中:${profile.gameName}` : profile.state}`,
          `资料:${profile.visibility}`,
        ];
        if (profile.realName) lines.push(`真实名:${profile.realName}`);
        if (profile.createdAt) lines.push(`注册:${fmtDateTime(profile.createdAt, deps.timezone).slice(0, 10)}`);
        if (profile.countryCode) lines.push(`国家/地区:${profile.countryCode}`);
        if (profile.profileUrl) lines.push(`主页:${profile.profileUrl}`);
        if (profile.state === '离线' && profile.lastLogOff) {
          lines.push(`上次下线:${fmtDateTime(profile.lastLogOff, deps.timezone).slice(0, 16)}`);
        }
        if (profile.visibility === '私密') lines.push('(资料是私密的:好友以外只看得到昵称和在线状态)');
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_now: async () => {
      try {
        const cfg = deps.cfg();
        const library = await loadLibrary(cfg);
        const check = crossCheck({
          steamPath: library.steamPath,
          registryAppId: library.running.appid === '0' ? '' : library.running.appid,
        });

        // 只有 confirmed / likely 才算「现在在玩」
        if (check.verdict === 'idle') {
          return '现在没在玩 Steam 游戏。';
        }

        if (check.verdict === 'stale') {
          const app = library.byId.get(check.registryAppId);
          const lines = [
            `${verdictTag(check)}`,
            `Steam 记着 ${appLabel(app, check.registryAppId)},但进程表里没有它。`,
            '大概率是退出游戏后注册表残留的值,不是真的在玩。',
          ];
          if (app?.lastPlayed) lines.push(`上次真正玩是 ${fmtDateTime(app.lastPlayed, deps.timezone).slice(0, 16)}`);
          return lines.join('\n');
        }

        if (check.verdict === 'outside') {
          const appid = check.processes[0].appid;
          const app = library.byId.get(appid);
          return [
            `${verdictTag(check)}`,
            `进程表里有 ${appLabel(app, appid)}(${check.processes[0].exe})在跑,`,
            '但 Steam 没把它记成「正在玩」——可能是从 Steam 外面启动的,或者游戏没接入 Steam 状态。',
          ].join('\n');
        }

        const appid = check.registryAppId || check.processes[0]?.appid || '';
        const app = library.byId.get(appid);
        const lines = [`${verdictTag(check)}:${appLabel(app, appid)}`];
        if (app && app.playtime > 0) lines.push(`累计 ${hours(app.playtime)}`);
        const nowAch = gameAchievements(library, appid);
        if (nowAch) {
          lines.push(`成就 ${nowAch.unlocked}/${nowAch.total}(${Math.round(nowAch.percentage)}%)`);
        }
        lines.push('');
        lines.push(check.reason);
        if (check.verdict === 'likely') {
          lines.push('(进程确实在跑,但没抓到它的主窗口,所以只报到「大概在玩」)');
        }
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_playtime: async (args) => {
      try {
        const cfg = deps.cfg();
        const library = await loadLibrary(cfg);
        const query = asString(args.query);
        const top = asInt(args.top, 10, 1, 50);
        const sinceRaw = asString(args.since);
        const since = sinceRaw ? parsePoint(sinceRaw, Date.now(), deps.timezone) ?? 0 : 0;

        let pool = library.apps;
        if (since > 0) pool = pool.filter((app) => app.lastPlayed >= since);

        if (query) {
          const queries = query.split(/[,，、]/).map((part) => part.trim()).filter(Boolean);
          const lines: string[] = [];
          for (const part of queries) {
            const hits = await resolveApps(cfg, library, part);
            if (hits.length === 0) {
              lines.push(`${part}:库里没有匹配的游戏`);
              continue;
            }
            for (const app of hits.slice(0, 5)) {
              // 名字是从商店搜到的、本地库里没有这款:说明没买过或没在这个账号玩过
              if (!library.byId.has(app.appid)) {
                lines.push(`- ${appLabel(app, app.appid)} — 库里没有它的游玩记录(没买过,或没在这个账号玩过)`);
                continue;
              }
              const bits = [`${appLabel(app, app.appid)} — 累计 ${hours(app.playtime)}`];
              if (app.lastPlayed) bits.push(`最后玩 ${fmtDateTime(app.lastPlayed, deps.timezone).slice(0, 10)}`);
              if (!app.installed) bits.push('未安装');
              const ach = gameAchievements(library, app.appid);
              if (ach) bits.push(`成就 ${ach.unlocked}/${ach.total}`);
              lines.push(`- ${bits.join(' · ')}`);
            }
          }
          return lines.join('\n');
        }

        const sorted = [...pool].filter((app) => app.playtime > 0).sort((a, b) => b.playtime - a.playtime).slice(0, top);
        if (sorted.length === 0) return '没有游玩记录。';
        const total = pool.reduce((sum, app) => sum + app.playtime, 0);
        const totalLabel = asString(args.since) ? `筛出的 ${sorted.length} 款合计` : '全部累计';
        const lines = [`玩得最久的 ${sorted.length} 款(${totalLabel} ${hours(total)}):`];
        sorted.forEach((app, index) => {
          const last = app.lastPlayed ? ` · 最后 ${fmtDateTime(app.lastPlayed, deps.timezone).slice(0, 10)}` : '';
          lines.push(`  ${index + 1}. ${appLabel(app, app.appid)} — ${hours(app.playtime)}${last}`);
        });
        if (library.missingNames > 0) {
          lines.push(`(还有 ${library.missingNames} 款只有 appid 没有名字,配了 Steam Web API key 就能显示)`);
        }
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_library: async (args) => {
      try {
        const library = await loadLibrary(deps.cfg());
        const filter = asString(args.filter) ?? 'installed';
        const limit = asInt(args.limit, 25, 1, 200);

        let pool = library.apps;
        if (filter === 'installed') pool = pool.filter((app) => app.installed);
        else if (filter === 'played') pool = pool.filter((app) => app.playtime > 0);
        else if (filter === 'untouched') pool = pool.filter((app) => app.playtime === 0);

        const sorted = [...pool].sort((a, b) => (b.playtime || 0) - (a.playtime || 0));
        if (sorted.length === 0) return `(${filter} 里没有游戏)`;

        const labels: Record<string, string> = {
          installed: '已安装',
          played: '有游玩记录',
          untouched: '一次没玩过',
          all: '全部',
        };
        const lines = [`${labels[filter] ?? filter}:${sorted.length} 款`];
        for (const app of sorted.slice(0, limit)) {
          const bits = [appLabel(app, app.appid)];
          if (app.playtime > 0) bits.push(hours(app.playtime));
          else bits.push('没玩过');
          lines.push(`  - ${bits.join(' · ')}`);
        }
        if (sorted.length > limit) lines.push(`  …还有 ${sorted.length - limit} 款`);
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_achievements: async (args) => {
      try {
        const cfg = deps.cfg();
        const library = await loadLibrary(cfg);
        const withAch = library.apps.filter((app) => app.achievements);
        const query = asString(args.query);

        if (query) {
          const hits = await resolveApps(cfg, library, query);
          if (hits.length === 0) return `库里没有匹配「${query}」的游戏。`;
          const wantsMissing = args.show_missing === true;
          const lines: string[] = [];
          for (const app of hits.slice(0, 3)) {
            const label = appLabel(app, app.appid);
            const detail = gameAchievements(library, app.appid);
            if (!detail) {
              lines.push(`${label}:本地没有成就记录(可能这游戏没成就,或者还没同步过)`);
              if (wantsMissing) {
                lines.push(
                  ...(library.hasApiKey && library.steamId64
                    ? await achievementGaps(cfg, library.steamId64, app.appid)
                    : [NO_KEY_MISSING]),
                );
              }
              continue;
            }

            lines.push(
              `${label}:${detail.unlocked}/${detail.total}(${Math.round(detail.percentage)}%)${detail.allUnlocked ? ' 全成就 🎉' : ''}`,
            );
            if (!wantsMissing) continue;
            if (detail.allUnlocked) {
              lines.push('  🎉 全成就,一个不剩');
              continue;
            }

            // 本地这份带每条的名字,不用 key 也能列出缺哪几个;有 key 再叠全服完成率
            const missing = detail.items.filter((item) => !item.achieved && !item.hidden);
            if (missing.length === 0) {
              if (!library.hasApiKey || !library.steamId64) lines.push(NO_KEY_MISSING);
              else lines.push(...(await achievementGaps(cfg, library.steamId64, app.appid)));
              continue;
            }

            const rarity = library.hasApiKey ? await fetchGlobalAchievementPercents(app.appid) : null;
            const sorted = [...missing].sort((a, b) => (rarity?.get(a.id) ?? 101) - (rarity?.get(b.id) ?? 101));
            lines.push(`  还差 ${missing.length} 个${rarity ? ',从全服最稀有的开始' : ''}:`);
            for (const item of sorted.slice(0, 10)) {
              const percent = rarity?.get(item.id);
              const rare = percent !== undefined ? `(全服 ${percent.toFixed(1)}%)` : '';
              const desc = item.description ? ` — ${item.description}` : '';
              lines.push(`    · ${item.name}${rare}${desc}`);
            }
            if (sorted.length > 10) lines.push(`    …还有 ${sorted.length - 10} 个`);
          }
          return lines.join('\n');
        }

        if (withAch.length === 0) {
          return '本地没有成就缓存。开着 Steam 玩一会儿、或者让它同步一次成就,再看就有了。';
        }
        const totalUnlocked = withAch.reduce((sum, app) => sum + (app.achievements?.unlocked ?? 0), 0);
        const totalAll = withAch.reduce((sum, app) => sum + (app.achievements?.total ?? 0), 0);
        const perfect = withAch.filter((app) => app.achievements?.allUnlocked);
        const lines = [
          `成就总览:${withAch.length} 款有成就记录,共 ${totalUnlocked}/${totalAll}(${totalAll ? Math.round((totalUnlocked / totalAll) * 100) : 0}%)`,
          `全成就:${perfect.length} 款${perfect.length ? ` — ${perfect.slice(0, 8).map((app) => appLabel(app, app.appid)).join('、')}` : ''}`,
          '',
          '进度最高的几款:',
        ];
        const ranked = [...withAch].sort((a, b) => (b.achievements?.percentage ?? 0) - (a.achievements?.percentage ?? 0)).slice(0, 8);
        for (const app of ranked) {
          const ach = app.achievements!;
          lines.push(`  - ${appLabel(app, app.appid)}:${ach.unlocked}/${ach.total}(${Math.round(ach.percentage)}%)`);
        }
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_recent: async (args) => {
      try {
        const cfg = deps.cfg();
        const limit = asInt(args.limit, 10, 1, 50);
        const local = localConfig(cfg);

        // 有 key 就走官方接口,拿得到两周时长;失败(账号私密/没 key)再退回本地。
        if (local.apiKey) {
          const steamPath = detectSteamPath(local);
          const steamId64 = toSteamId64(detectSteamId(local, steamPath));
          const recent = steamId64 ? await fetchRecentlyPlayed(webConfig(cfg, steamId64)) : null;
          if (recent) {
            if (recent.length === 0) return '最近两周没有游玩记录。';
            const total = recent.reduce((sum, game) => sum + game.playtimeTwoWeeks, 0);
            const lines = [`最近两周玩过 ${recent.length} 款(这两周合计 ${hours(total)}):`];
            for (const game of [...recent].sort((a, b) => b.playtimeTwoWeeks - a.playtimeTwoWeeks).slice(0, limit)) {
              const bits = [`${game.name || `appid ${game.appid}`}(${game.appid})`];
              bits.push(`这两周 ${hours(game.playtimeTwoWeeks)}`);
              if (game.playtimeForever > 0) bits.push(`共 ${hours(game.playtimeForever)}`);
              lines.push(`  - ${bits.join(' · ')}`);
            }
            return lines.join('\n');
          }
        }

        // 本地兜底:只有最后游玩时间,没有两周时长(Steam 不在本地存这个窗口的累计)。
        const library = await loadLibrary(cfg);
        const since = Date.now() - 14 * 24 * 3_600_000;
        const pool = library.apps
          .filter((app) => app.lastPlayed >= since)
          .sort((a, b) => b.lastPlayed - a.lastPlayed)
          .slice(0, limit);
        if (pool.length === 0) {
          return local.apiKey ? '最近两周没有游玩记录。' : '最近两周没有游玩记录(本地只有「最后游玩时间」,两周时长要配 Steam Web API key)。';
        }
        const lines = [
          local.apiKey
            ? `最近 14 天有游玩记录 ${pool.length} 款(Steam 接口没给两周时长,下面是本地记录):`
            : `最近 14 天有游玩记录 ${pool.length} 款(本地只有最后游玩时间;两周时长要配 Steam Web API key):`,
        ];
        for (const app of pool) {
          const bits = [appLabel(app, app.appid), `最后 ${fmtDateTime(app.lastPlayed, deps.timezone).slice(0, 10)}`];
          if (app.playtime > 0) bits.push(`共 ${hours(app.playtime)}`);
          lines.push(`  - ${bits.join(' · ')}`);
        }
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_price: async (args) => {
      try {
        const cfg = deps.cfg();
        const query = asString(args.query);
        if (!query) return '要给一个游戏名或 appid。';
        const refresh = args.refresh === true;
        const country = ((cfg.priceCountry ?? 'CN').trim() || 'CN').toUpperCase();
        const cc = country.toLowerCase();

        // 1. 先认 appid:纯数字直接当 appid(不用联网),否则查本地库,再不然去 Steam 商店搜
        let appid = /^\d{2,8}$/.test(query) ? query : '';
        let name = '';
        try {
          const library = await loadLibrary(cfg);
          if (appid) {
            name = library.byId.get(appid)?.name ?? '';
          } else {
            const hit = findApps(library, query)[0];
            if (hit) {
              appid = hit.appid;
              name = hit.name;
            }
          }
        } catch {
          // Steam 没装或目录不对也能查价,继续走商店搜索
        }
        if (!appid) {
          const found = await searchSteamAppId(query, cc);
          if (found.kind === 'failed') {
            const wait = Math.ceil(storeCooldownLeft() / 1000);
            return `Steam 商店这会儿没响应(被限流了),查不到「${query}」。${wait > 0 ? `${wait} 秒后再试,` : '过一会儿再试,'}或者直接把 appid 告诉我。`;
          }
          if (found.kind === 'none') return `库里没有、Steam ${country} 商店也没搜到「${query}」。`;
          appid = found.appid;
          name = found.name;
        }

        const cache = priceCacheFor(deps.dataDir);
        // 缓存必须按「appid + 地区」分开:同一个游戏国区 ¥48、美区 $14.99,串了就报错价
        const cacheKey = `${appid}@${country}`;
        const cached = cache.get(cacheKey);
        const now = Date.now();
        // 2. 现价:Steam Storefront,币种跟着国家走,不做任何换算
        let current: SteamPriceResult | undefined = cached.current;
        let currentFresh = false;
        if (!current || refresh || !cached.currentAt || now - cached.currentAt > CURRENT_TTL_MS) {
          const fetched = await fetchSteamPrice(appid, cc);
          if (fetched.kind !== 'failed') {
            current = fetched;
            currentFresh = true;
            cache.set(cacheKey, { name: name || cached.name, current, currentAt: now });
          }
        }

        // 3. 史低:ITAD 按国家算,拿到的是该区的历史最低,不是美元换算
        const itadKey = (deps.itadKey?.() ?? '').trim();
        let history = cached.history;
        let historyFresh = false;
        if (itadKey && (!history || refresh || !cached.historyAt || now - cached.historyAt > HISTORY_TTL_MS)) {
          const looked = await itadLookup(appid, itadKey);
          // 库里没名字、商店又没响应时,ITAD 的标题就是唯一能用的
          if (!name && looked?.title) name = looked.title;
          const fetched = looked ? await itadPrices(looked.id, country, itadKey) : null;
          if (fetched) {
            history = fetched;
            historyFresh = true;
            cache.set(cacheKey, { name: name || cached.name, history, historyAt: now });
          }
        }

        // 4. 组装:先现价,再史低,再对比
        const displayName = name || cached.name || `appid ${appid}`;
        const lines = [`《${displayName}》(appid ${appid})`];
        // ITAD 里 Steam 那条是 0 元,说明这款现在免费
        const freeByItad = Boolean(history?.steamNow && history.steamNow.amount <= 0.004);
        const isFree = current?.kind === 'free' || ((!current || current.kind === 'failed') && freeByItad);
        if (!current || current.kind === 'failed') {
          // 实时价拉不到时,ITAD 里那条 Steam 记录可以兜底(注明不是实时价)
          lines.push(
            freeByItad
              ? 'Steam:免费游戏'
              : history?.steamNow
                ? `Steam:实时价没拉到;ITAD 记录的是 ${formatAmount(history.steamNow.amount, history.steamNow.currency)}${history.steamNow.cut > 0 ? `(-${history.steamNow.cut}%)` : ''}`
                : 'Steam:现价没拉到(商店限流或网络抖动),过一会儿再试。',
          );
        } else if (current.kind === 'free') {
          lines.push('Steam:免费游戏');
        } else if (current.kind === 'unavailable') {
          lines.push(`Steam:${country} 区没有在售价格(未上架、区域锁定或已下架)`);
        } else {
          const price = current.price;
          lines.push(
            price.discountPercent > 0
              ? `Steam ${country} 现价:${formatMinor(price.final, price.currency)} · -${price.discountPercent}%(原价 ${formatMinor(price.initial, price.currency)})`
              : `Steam ${country} 现价:${formatMinor(price.final, price.currency)}(当前没折扣)`,
          );
        }

        if (isFree) {
          lines.push('史低:现在是免费游戏,历史低价没有参考意义(它可能以前是付费的)。');
        } else if (!itadKey) {
          lines.push('');
          lines.push('史低:查不到——没配 ITAD API key。ITAD 免费,登录后在 isthereanydeal.com/apps/my 建一个应用就有 key,填到「Steam API key」面板的第二个输入框。');
        } else if (!history) {
          lines.push('史低:ITAD 没有这款的记录(冷门或未收录),只能看现价。');
        } else {
          const bits = [`史低:${formatAmount(history.all, history.currency)}(ITAD,${country} 区,全时段)`];
          if (history.y1 !== null) bits.push(`近一年 ${formatAmount(history.y1, history.currency)}`);
          if (history.m3 !== null) bits.push(`近三月 ${formatAmount(history.m3, history.currency)}`);
          lines.push(bits.join(' · '));

          if (current?.kind === 'priced' && current.price.currency === history.currency) {
            const diff = current.price.final / 100 - history.all;
            if (diff <= 0.01) {
              lines.push('对比:现在就等于史低(或更低)');
            } else if (history.all > 0) {
              lines.push(`对比:现价比史低高 ${formatAmount(diff, history.currency)}(+${Math.round((diff / history.all) * 100)}%)`);
            }
          } else if (current?.kind === 'priced') {
            lines.push(`对比:现价币种(${current.price.currency})和史低(${history.currency})不同,不做换算`);
          }

          // 只有真的比 Steam 便宜才提;同价或更贵就是噪音
          const best = history.bestNow;
          const steamNow = current?.kind === 'priced'
            ? current.price.final / 100
            : history.steamNow?.amount ?? null;
          if (best && (steamNow === null || best.amount < steamNow - 0.005)) {
            const cut = best.cut > 0 ? `,-${best.cut}%` : '';
            const label = steamNow === null ? '其他商店' : '别处更便宜';
            lines.push(`${label}:${formatAmount(best.amount, best.currency)}(${best.shop}${cut})`);
          }
        }

        const notes: string[] = [];
        if (current && !currentFresh && cached.currentAt) notes.push(`现价 ${minutesAgo(cached.currentAt)}`);
        if (history && !historyFresh && cached.historyAt) notes.push(`史低 ${minutesAgo(cached.historyAt)}`);
        if (notes.length > 0) {
          lines.push(refresh
            ? `(刷新没成功,先用本地缓存:${notes.join('、')})`
            : `(取自本地缓存:${notes.join('、')};要最新的带 refresh: true)`);
        }
        lines.push('价格来自 Steam Store,史低来自 IsThereAnyDeal;两者都会变,别当成承诺。');
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_friends: async (args) => {
      try {
        const cfg = deps.cfg();
        // 默认关闭:读好友列表属于隐私数据,开关在配置页 worlds.steam.friendsEnabled。
        if (cfg.friendsEnabled !== true) {
          return '好友查询是关着的(worlds.steam.friendsEnabled,默认关闭)。要查就让用户到设置里打开——它会读好友列表,属于隐私数据。';
        }
        const local = localConfig(cfg);
        if (!local.apiKey) return '查好友需要 Steam Web API key(Steam 没有免 key 的公开接口)。让用户到「Steam」页填一个。';

        const steamPath = detectSteamPath(local);
        const steamId64 = toSteamId64(detectSteamId(local, steamPath));
        if (!steamId64) return '拿不到当前账号的 SteamID64,先在配置里填一下(32 位账号 ID 或 64 位都行)。';

        const onlyOnline = args.only_online !== false;
        const limit = asInt(args.limit, 20, 1, 100);

        const ids = await fetchFriendIds(webConfig(cfg, steamId64));
        if (!ids) {
          return '拿不到好友列表:要么「好友列表」是私密的,要么这把 key 不属于这个账号(Steam 对这个接口要求 key 与账号一致)。';
        }
        if (ids.length === 0) return '这个账号没有好友。';

        const people = await fetchPlayerSummaries(webConfig(cfg, steamId64), ids);
        if (!people) return '好友资料拿不到(接口临时失败,过一会儿再试)。';

        const inGame = people.filter((person) => person.gameName);
        const online = people.filter((person) => !person.gameName && person.state !== '离线');
        const offline = people.filter((person) => !person.gameName && person.state === '离线');
        const shown = onlyOnline
          ? [...inGame, ...online].slice(0, limit)
          : [...inGame, ...online, ...offline].slice(0, limit);

        const lines = [`好友 ${people.length} 位:游戏中 ${inGame.length}、在线 ${online.length}、离线 ${offline.length}`];
        if (shown.length === 0) {
          lines.push('现在没人在线。');
          return lines.join('\n');
        }
        for (const person of shown) {
          const suffix = person.gameName ? `游戏中:${person.gameName}` : person.state;
          lines.push(`  - ${person.name || person.steamId} — ${suffix}`);
        }
        if (onlyOnline && offline.length > 0) lines.push(`(另有 ${offline.length} 位离线;要看就传 only_online=false)`);
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    steam_status: async () => {
      try {
        const cfg = deps.cfg();
        const library = await loadLibrary(cfg);
        const shots = readScreenshots(library.steamPath, library.accountId);

        // 顺手跑一次交叉校验,让状态页和 steam_now 口径一致
        const check = crossCheck({
          steamPath: library.steamPath,
          registryAppId: library.running.appid === '0' ? '' : library.running.appid,
        });

        const nowText = (() => {
          if (check.verdict === 'idle') return '没在玩';
          const appid = check.registryAppId || check.processes[0]?.appid || '';
          const app = library.byId.get(appid);
          return `${verdictTag(check)} ${appLabel(app, appid)}`;
        })();

        const keyState = library.hasApiKey && library.steamId64 ? await apiKeyState(cfg, library.steamId64) : 'unknown';
        const keyText = !library.hasApiKey
          ? '未配置(未安装的游戏显示不出名字)'
          : keyState === 'denied'
            ? '已配置,但 Steam 拒绝了这把 key(401/403);去 steamcommunity.com/dev/apikey 重新签一把'
            : keyState === 'no-player'
              ? '已配置,但查不到这个 SteamID64 的玩家:检查账号 ID,或把「游戏详情」设为公开'
              : '已配置';

        // 网络方式要说实话:配了代理但 undici 找不到时,实际是直连
        const net = await httpStatus();
        const netText = net.proxy
          ? net.usable
            ? `代理 ${net.proxy}`
            : `配了代理 ${net.proxy},但走不通(找不到 undici),实际直连`
          : '直连';

        const lines = [
          `Steam 目录:${library.steamPath}`,
          `账号:${library.steamId64 ? `${library.steamId64}(账号 ID ${library.accountId})` : library.accountId || '未识别'}`,
          `API key:${keyText}`,
          `好友查询:${cfg.friendsEnabled === true ? '已开启' : '关闭(默认)'}`,
          `网络:${netText}`,
          `游戏:${library.apps.length} 条记录,其中已安装 ${library.apps.filter((app) => app.installed).length} 款`,
          `有游玩时长:${library.apps.filter((app) => app.playtime > 0).length} 款`,
          `有成就缓存:${library.apps.filter((app) => app.achievements).length} 款`,
          `截图:${shots.size} 款游戏共 ${[...shots.values()].reduce((sum, item) => sum + item.count, 0)} 张`,
          `当前状态:${nowText}`,
          `交叉校验:Steam 注册表 ${check.registryAppId || '空'} · 进程 ${check.processes.length} 个 · 有可见主窗口 ${check.windows.length} 个`,
        ];
        if (library.missingNames > 0) {
          lines.push('');
          lines.push(
            keyState === 'denied'
              ? `提示:${library.missingNames} 款游戏只有 appid。现在这把 key 被 Steam 拒绝了,换一把新 key 才能补名字。`
              : `提示:${library.missingNames} 款游戏只有 appid。填了 apiKey 就能补名字——在 https://steamcommunity.com/dev/apikey 免费申请。`,
          );
        }
        return lines.join('\n');
      } catch (error) {
        return `[tool failed] ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };

  // 每次调用都按当前配置刷新代理设置(改 proxy 不用重启)
  return STEAM_TOOL_DECLS.map((decl) => ({
    ...decl,
    handler: (args, ctx) => {
      setProxy(deps.cfg().proxy);
      return handlers[decl.name]!(args, ctx);
    },
  }));
}
