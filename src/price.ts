/**
 * 价格与历史低价。
 *
 * 两个来源,各管一件事:
 *  - Steam Storefront `appdetails`(免 key):**你所在区的官方现价与折扣**,币种跟着 cc 走。
 *  - IsThereAnyDeal `/games/prices/v3`(免费 key,`country` 参数):**该区的历史最低价**,
 *    顺带给出各商店当前最低。ITAD 按国家算低价,所以国区史低不会被美元换算污染。
 *
 * 不在插件里做「值不值得买」的判断,只把事实给模型。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { httpRequest } from './http.ts';

export interface SteamPrice {
  appid: string;
  currency: string;
  /** 原价,最小货币单位(分) */
  initial: number;
  /** 现价,最小货币单位(分) */
  final: number;
  discountPercent: number;
}

export type SteamPriceResult =
  | { kind: 'priced'; price: SteamPrice }
  | { kind: 'free' }
  /** 这个区不卖 / 还没上架 */
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export interface ShopDeal {
  shop: string;
  amount: number;
  currency: string;
  cut: number;
}

export interface HistoryLow {
  currency: string;
  /** 全时段最低 */
  all: number;
  /** 近一年最低,null=没数据 */
  y1: number | null;
  /** 近三个月最低,null=没数据 */
  m3: number | null;
  /** 各商店里最便宜的那一条(不含 Steam,Steam 的价格单独报) */
  bestNow: ShopDeal | null;
  /** ITAD 记录的 Steam 现价:实时价拉不到时用它兜底 */
  steamNow: ShopDeal | null;
}

const STEAM_STORE = 'https://store.steampowered.com';
const ITAD_API = 'https://api.isthereanydeal.com';

/**
 * Steam 商店对短时间内的连续请求很不客气:超了不是回 429,而是**直接挂住不响应**。
 * 所以商店请求统一走这个闸:两次之间至少隔 1 秒,单次超时 8 秒且不重试
 * (重试只会让用户干等 16 秒)。一旦失败,冷却 90 秒,期间直接快速失败,
 * 不让用户对着 8 秒的等待反复排队。
 */
const STORE_MIN_GAP_MS = 1000;
const STORE_COOLDOWN_MS = 90_000;
let lastStoreCallAt = 0;
let storeCooldownUntil = 0;

/** 冷却还剩多久(毫秒);0 表示没在冷却。 */
export function storeCooldownLeft(): number {
  return Math.max(0, storeCooldownUntil - Date.now());
}

/** 测试用:清掉节流状态。 */
export function resetStoreThrottle(): void {
  lastStoreCallAt = 0;
  storeCooldownUntil = 0;
}

/** 通过返回 true,还在冷却返回 false(调用方直接判失败,不再发请求)。 */
async function storeGate(): Promise<boolean> {
  if (Date.now() < storeCooldownUntil) return false;
  const wait = STORE_MIN_GAP_MS - (Date.now() - lastStoreCallAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastStoreCallAt = Date.now();
  return true;
}

function markStoreFailure(): void {
  storeCooldownUntil = Date.now() + STORE_COOLDOWN_MS;
}

/** 网络抖动重试一次;HTTP 4xx 直接放弃(权限或参数问题)。 */
async function requestJson<T>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
  retry = true,
): Promise<T | null> {
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await httpRequest(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs,
    });
    if (result) {
      if (!result.ok) return null;
      try {
        return JSON.parse(result.text) as T;
      } catch {
        return null;
      }
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** Steam 国区/某区现价。cc 是两位小写国家码。 */
export async function fetchSteamPrice(appid: string, cc: string, timeoutMs = 8000): Promise<SteamPriceResult> {
  const url =
    `${STEAM_STORE}/api/appdetails?appids=${encodeURIComponent(appid)}` +
    `&cc=${encodeURIComponent(cc.toLowerCase())}&l=schinese&filters=price_overview`;
  if (!(await storeGate())) return { kind: 'failed' };
  const data = await requestJson<Record<string, {
    success?: boolean;
    data?: {
      is_free?: boolean;
      price_overview?: { currency?: string; initial?: number; final?: number; discount_percent?: number };
    };
  }>>(url, { method: 'GET' }, timeoutMs, false);
  if (!data) {
    markStoreFailure();
    return { kind: 'failed' };
  }
  const entry = data[appid];
  if (!entry?.success || !entry.data) return { kind: 'unavailable' };

  const overview = entry.data.price_overview;
  if (!overview) return entry.data.is_free ? { kind: 'free' } : { kind: 'unavailable' };

  return {
    kind: 'priced',
    price: {
      appid,
      currency: overview.currency ?? '',
      initial: Number(overview.initial ?? 0),
      final: Number(overview.final ?? 0),
      discountPercent: Number(overview.discount_percent ?? 0),
    },
  };
}

export type SteamSearchResult =
  | { kind: 'ok'; appid: string; name: string }
  | { kind: 'none' }
  | { kind: 'failed' };

/**
 * 按名字在 Steam 商店搜一个 appid(库里没有的游戏用这个)。
 * 「没搜到」和「商店没响应」必须分开:前者是用户的输入问题,后者是网络问题。
 */
export async function searchSteamAppId(term: string, cc: string, timeoutMs = 8000): Promise<SteamSearchResult> {
  const url =
    `${STEAM_STORE}/api/storesearch/?term=${encodeURIComponent(term)}` +
    `&cc=${encodeURIComponent(cc.toLowerCase())}&l=schinese`;
  if (!(await storeGate())) return { kind: 'failed' };
  const data = await requestJson<{ items?: Array<{ id?: number; name?: string; type?: string }> }>(
    url,
    { method: 'GET' },
    timeoutMs,
    false,
  );
  if (!data) {
    markStoreFailure();
    return { kind: 'failed' };
  }
  const items = data.items;
  if (!Array.isArray(items) || items.length === 0) return { kind: 'none' };
  const hit = items.find((item) => item.id && item.type === 'app') ?? items.find((item) => item.id);
  if (!hit?.id) return { kind: 'none' };
  return { kind: 'ok', appid: String(hit.id), name: hit.name ?? '' };
}

/**
 * Steam appid → ITAD 的 UUID,顺带把 ITAD 那边的标题带回来
 * (库里没有、Steam 商店又没响应时,标题就靠它)。
 */
export async function itadLookup(appid: string, apiKey: string, timeoutMs = 12000): Promise<{ id: string; title: string } | null> {
  if (!apiKey) return null;
  const url = `${ITAD_API}/games/lookup/v1?appid=${encodeURIComponent(appid)}&key=${encodeURIComponent(apiKey)}`;
  const data = await requestJson<{ found?: boolean; game?: { id?: string; title?: string } }>(url, { method: 'GET' }, timeoutMs);
  if (!data?.found || !data.game?.id) return null;
  return { id: data.game.id, title: data.game.title ?? '' };
}

/**
 * ITAD 现价 + 历史低价,**按国家算**(country=CN 拿到的就是国区历史低价)。
 * 返回体在 v3 里可能是按 id 索引的对象,也可能直接是数组,两种都认。
 */
export async function itadPrices(gameId: string, country: string, apiKey: string, timeoutMs = 15000): Promise<HistoryLow | null> {
  if (!apiKey) return null;
  const url = `${ITAD_API}/games/prices/v3?country=${encodeURIComponent(country.toUpperCase())}&key=${encodeURIComponent(apiKey)}`;
  const data = await requestJson<
    | Array<{ historyLow?: RawLow; deals?: RawDeal[] }>
    | Record<string, { historyLow?: RawLow; deals?: RawDeal[] }>
  >(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([gameId]),
  }, timeoutMs);
  if (!data) return null;

  const entry = Array.isArray(data) ? data[0] : data[gameId] ?? Object.values(data)[0];
  if (!entry) return null;

  const low = entry.historyLow;
  if (!low?.all) return null;

  const deals = Array.isArray(entry.deals) ? entry.deals : [];
  const toDeal = (deal: RawDeal | undefined): ShopDeal | null =>
    deal && typeof deal.price?.amount === 'number'
      ? {
          shop: deal.shop?.name ?? '未知商店',
          amount: Number(deal.price.amount),
          currency: deal.price.currency ?? '',
          cut: Number(deal.cut ?? 0),
        }
      : null;

  // Steam 自己的价格已经在现价那行报过了,「别处」只挑别的商店,
  // 否则会出现「其他商店:¥48(GOG)」——和 Steam 同价,没有信息量。
  const cheapest = deals
    .filter((deal) => typeof deal.price?.amount === 'number')
    .filter((deal) => (deal.shop?.name ?? '').toLowerCase() !== 'steam')
    .sort((a, b) => (a.price!.amount as number) - (b.price!.amount as number))[0];
  const steamDeal = deals.find((deal) => (deal.shop?.name ?? '').toLowerCase() === 'steam');

  return {
    currency: low.all.currency ?? '',
    all: Number(low.all.amount ?? 0),
    y1: typeof low.y1?.amount === 'number' ? low.y1.amount : null,
    m3: typeof low.m3?.amount === 'number' ? low.m3.amount : null,
    bestNow: toDeal(cheapest),
    steamNow: toDeal(steamDeal),
  };
}

interface RawLow {
  all?: { amount?: number; currency?: string };
  y1?: { amount?: number; currency?: string };
  m3?: { amount?: number; currency?: string };
}

interface RawDeal {
  shop?: { name?: string };
  price?: { amount?: number; currency?: string };
  cut?: number;
}

// ── 本地缓存:拉一次就存下来,不重复问 ─────────────────────────────

/** 现价变化快,1 小时;史低变化慢,24 小时。 */
export const CURRENT_TTL_MS = 60 * 60_000;
export const HISTORY_TTL_MS = 24 * 60 * 60_000;
/** 超过这个时间的条目在保存时清掉,文件不会越滚越大。 */
const ENTRY_TTL_MS = 30 * 24 * 60 * 60_000;

export interface PriceCacheEntry {
  name?: string;
  currentAt?: number;
  current?: SteamPriceResult;
  historyAt?: number;
  history?: HistoryLow;
}

interface PriceCacheFile {
  version: 1;
  entries: Record<string, PriceCacheEntry>;
}

/**
 * 价格缓存,落在 `<dataDir>/steam-prices.json`(文件名带 world id 前缀,
 * 因为 dataDir 是所有 World 共用的)。
 */
export class PriceCache {
  private data: PriceCacheFile | null = null;

  constructor(private readonly file: string) {}

  /** dataDir 为空时退化成纯内存,不当场报错。 */
  static inDir(dataDir: string): PriceCache {
    return new PriceCache(dataDir ? join(dataDir, 'steam-prices.json') : '');
  }

  private load(): PriceCacheFile {
    if (this.data) return this.data;
    this.data = { version: 1, entries: {} };
    if (!this.file || !existsSync(this.file)) return this.data;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as PriceCacheFile;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') this.data = parsed;
    } catch {
      // 坏了就当空的,下一次写入会覆盖
    }
    return this.data;
  }

  get(appid: string): PriceCacheEntry {
    return this.load().entries[appid] ?? {};
  }

  /** 合并写一条,顺手清掉过期条目。 */
  set(appid: string, patch: PriceCacheEntry): void {
    const data = this.load();
    data.entries[appid] = { ...data.entries[appid], ...patch };
    this.flush(data);
  }

  private flush(data: PriceCacheFile): void {
    if (!this.file) return;
    const now = Date.now();
    for (const [appid, entry] of Object.entries(data.entries)) {
      const newest = Math.max(entry.currentAt ?? 0, entry.historyAt ?? 0);
      if (newest > 0 && now - newest > ENTRY_TTL_MS) delete data.entries[appid];
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // 写不进去不影响本次回答
    }
  }
}

/** 分 → 带符号的金额;币种不认识时退回「代码 金额」。 */
export function formatMinor(minorUnits: number, currency: string): string {
  const value = (minorUnits / 100).toFixed(2);
  if (currency === 'CNY') return `¥${value}`;
  if (currency === 'USD') return `$${value}`;
  return currency ? `${currency} ${value}` : value;
}

/** 浮点金额(ITAD 用)→ 带符号的金额。 */
export function formatAmount(amount: number, currency: string): string {
  const value = amount.toFixed(2);
  if (currency === 'CNY') return `¥${value}`;
  if (currency === 'USD') return `$${value}`;
  return currency ? `${currency} ${value}` : value;
}
