import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriceCache, fetchSteamPrice, formatAmount, formatMinor, itadPrices, resetStoreThrottle, searchSteamAppId, storeCooldownLeft } from '../src/price.ts';

/** 造一个最小可用的 fetch 响应。 */
function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
}

beforeEach(() => {
  resetStoreThrottle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSteamPrice', () => {
  it('解析国区现价与折扣,币种原样保留', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        '413150': {
          success: true,
          data: { price_overview: { currency: 'CNY', initial: 4800, final: 2400, discount_percent: 50 } },
        },
      }),
    );
    const result = await fetchSteamPrice('413150', 'cn');
    expect(result.kind).toBe('priced');
    if (result.kind === 'priced') {
      expect(result.price).toMatchObject({ currency: 'CNY', initial: 4800, final: 2400, discountPercent: 50 });
    }
  });

  it('没有 price_overview 但 is_free 时判免费', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ '570': { success: true, data: { is_free: true } } }));
    expect((await fetchSteamPrice('570', 'cn')).kind).toBe('free');
  });

  it('success=false 时判这个区不卖', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ '999': { success: false } }));
    expect((await fetchSteamPrice('999', 'cn')).kind).toBe('unavailable');
  });

  it('请求失败时返回 failed,不抛错,并进入冷却', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect((await fetchSteamPrice('413150', 'cn')).kind).toBe('failed');
    expect(storeCooldownLeft()).toBeGreaterThan(0);
  });

  it('冷却期内不再发请求,直接快速失败', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw new Error('offline');
    });
    await fetchSteamPrice('413150', 'cn');
    const before = calls;
    const started = Date.now();
    expect((await fetchSteamPrice('1245620', 'cn')).kind).toBe('failed');
    expect(calls).toBe(before);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('itadPrices', () => {
  const body = {
    historyLow: { all: { amount: 19, currency: 'CNY' }, y1: { amount: 19, currency: 'CNY' }, m3: { amount: 24, currency: 'CNY' } },
    deals: [
      { shop: { name: 'Steam' }, price: { amount: 24, currency: 'CNY' }, cut: 50 },
      { shop: { name: 'GOG' }, price: { amount: 28, currency: 'CNY' }, cut: 40 },
    ],
  };

  it('数组形态(文档示例)', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse([body]));
    const low = await itadPrices('uuid-1', 'CN', 'key');
    expect(low).toMatchObject({ all: 19, y1: 19, m3: 24, currency: 'CNY' });
    // Steam 自己的价格单独报,这里只挑别的商店 → GOG 28
    expect(low?.bestNow).toMatchObject({ shop: 'GOG', amount: 28, cut: 40 });
    // Steam 那条留着,实时价拉不到时兜底
    expect(low?.steamNow).toMatchObject({ shop: 'Steam', amount: 24, cut: 50 });
  });

  it('按 id 索引的对象形态也认', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ 'uuid-1': body }));
    const low = await itadPrices('uuid-1', 'CN', 'key');
    expect(low?.all).toBe(19);
    expect(low?.bestNow?.shop).toBe('GOG');
  });

  it('没有 key 时不发请求', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return jsonResponse([]);
    });
    expect(await itadPrices('uuid-1', 'CN', '')).toBeNull();
    expect(called).toBe(false);
  });

  it('没有 historyLow 时返回 null', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse([{ deals: [] }]));
    expect(await itadPrices('uuid-1', 'CN', 'key')).toBeNull();
  });

  it('只有 Steam 一家时不报「别处更便宜」', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse([{ historyLow: { all: { amount: 19, currency: 'CNY' } }, deals: [{ shop: { name: 'Steam' }, price: { amount: 48, currency: 'CNY' }, cut: 0 }] }]),
    );
    expect((await itadPrices('uuid-1', 'CN', 'key'))?.bestNow).toBeNull();
  });
});

describe('searchSteamAppId', () => {
  it('搜到就回 appid 与名字', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ items: [{ id: 1245620, name: '艾尔登法环', type: 'app' }] }),
    );
    expect(await searchSteamAppId('Elden Ring', 'cn')).toEqual({ kind: 'ok', appid: '1245620', name: '艾尔登法环' });
  });

  it('真的没搜到 → none,和网络失败区分开', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ items: [] }));
    expect((await searchSteamAppId('zzzz', 'cn')).kind).toBe('none');
  });

  it('商店没响应 → failed(不是 none)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('timeout');
    });
    expect((await searchSteamAppId('Elden Ring', 'cn')).kind).toBe('failed');
  });
});

describe('PriceCache', () => {
  it('写进文件再读回来,仍是同一份数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steam-price-'));
    const now = Date.now();
    const first = PriceCache.inDir(dir);
    first.set('413150', { name: 'Stardew Valley', currentAt: now, current: { kind: 'free' } });

    const second = PriceCache.inDir(dir);
    expect(second.get('413150').name).toBe('Stardew Valley');
    expect(second.get('413150').currentAt).toBe(now);

    const raw = JSON.parse(readFileSync(join(dir, 'steam-prices.json'), 'utf8'));
    expect(raw.version).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('dataDir 为空时退化成纯内存,不报错', () => {
    const cache = PriceCache.inDir('');
    cache.set('1', { name: 'x' });
    expect(cache.get('1').name).toBe('x');
  });

  it('坏文件不让读崩', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steam-price-bad-'));
    const cache = PriceCache.inDir(dir);
    cache.set('1', { name: 'x' });
    const file = join(dir, 'steam-prices.json');
    writeFileSync(file, 'not json', 'utf8');
    expect(PriceCache.inDir(dir).get('1')).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('金额格式化', () => {
  it('分 → 带符号金额', () => {
    expect(formatMinor(2400, 'CNY')).toBe('¥24.00');
    expect(formatMinor(1999, 'USD')).toBe('$19.99');
    expect(formatMinor(100, 'JPY')).toBe('JPY 1.00');
  });

  it('浮点金额 → 带符号金额', () => {
    expect(formatAmount(19, 'CNY')).toBe('¥19.00');
    expect(formatAmount(9.99, 'USD')).toBe('$9.99');
  });
});
