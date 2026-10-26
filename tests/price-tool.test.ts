import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetStoreThrottle } from '../src/price.ts';
import { steamTools } from '../src/tools.ts';

/** 一个按 URL 分流的假网络:Steam 商店挂掉,ITAD 正常。 */
function stubNetwork() {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;

    if (url.includes('storesearch')) {
      return json({ items: [{ id: 1091500, name: '赛博朋克 2077', type: 'app' }] });
    }
    if (url.includes('appdetails')) {
      throw new Error('store blocked'); // 模拟被限流:挂住直到超时
    }
    if (url.includes('/games/lookup/v1')) {
      return json({ found: true, game: { id: 'uuid-cp2077', title: 'Cyberpunk 2077' } });
    }
    if (url.includes('/games/prices/v3')) {
      return json([
        {
          id: 'uuid-cp2077',
          historyLow: { all: { amount: 89, currency: 'CNY' }, y1: { amount: 89, currency: 'CNY' }, m3: { amount: 89, currency: 'CNY' } },
          deals: [
            { shop: { name: 'Steam' }, price: { amount: 89, currency: 'CNY' }, cut: 70 },
            { shop: { name: 'GOG' }, price: { amount: 79, currency: 'CNY' }, cut: 73 },
          ],
        },
      ]);
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

async function callPrice(dataDir: string, args: Record<string, unknown>, country = 'CN'): Promise<string> {
  const tools = steamTools({
    cfg: () => ({
      enabled: true,
      // 故意指一个不存在的目录,让 loadLibrary 抛错,从而走商店搜索
      steamPath: 'E:\\definitely-not-a-steam-dir',
      steamId: '',
      apiKey: '',
      timeoutMs: 3000,
      priceCountry: country,
    }),
    timezone: 'Asia/Shanghai',
    itadKey: () => 'test-itad-key',
    dataDir,
  });
  const tool = tools.find((item) => item.name === 'steam_price')!;
  const out = await (tool.handler as unknown as (a: unknown) => Promise<string | { text: string }>)(args);
  return typeof out === 'string' ? out : out.text;
}

let dir = '';

beforeEach(() => {
  resetStoreThrottle();
  dir = mkdtempSync(join(tmpdir(), 'steam-price-tool-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('steam_price:Steam 挂掉时的降级', () => {
  it('实时价拉不到,用 ITAD 里的 Steam 记录兜底,并报出别处更便宜', async () => {
    stubNetwork();
    const text = await callPrice(dir, { query: '赛博朋克 2077' });

    expect(text).toContain('《赛博朋克 2077》(appid 1091500)');
    expect(text).toContain('ITAD 记录的是 ¥89.00(-70%)');
    expect(text).toContain('史低:¥89.00(ITAD,CN 区,全时段)');
    expect(text).toContain('别处更便宜:¥79.00(GOG,-73%)');
    expect(text).toContain('IsThereAnyDeal');
  });

  it('第二次查询命中缓存,不再打网络', async () => {
    stubNetwork();
    await callPrice(dir, { query: '赛博朋克 2077' });

    let after = 0;
    vi.stubGlobal('fetch', async () => {
      after += 1;
      throw new Error('should not be called');
    });
    const text = await callPrice(dir, { query: '1091500' });
    expect(after).toBe(0);
    expect(text).toContain('取自本地缓存');
  });

  it('refresh 时刷新失败,提示先用缓存', async () => {
    // 第一次:Steam 正常,拿得到现价并缓存
    let steamOk = true;
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;
      if (url.includes('appdetails')) {
        if (!steamOk) throw new Error('store blocked');
        return json({ '1091500': { success: true, data: { price_overview: { currency: 'CNY', initial: 29800, final: 8940, discount_percent: 70 } } } });
      }
      if (url.includes('/games/lookup/v1')) return json({ found: true, game: { id: 'uuid-cp2077' } });
      if (url.includes('/games/prices/v3')) return json([{ historyLow: { all: { amount: 89, currency: 'CNY' } }, deals: [] }]);
      throw new Error(`unexpected url: ${url}`);
    });

    const first = await callPrice(dir, { query: '1091500' });
    expect(first).toContain('Steam CN 现价:¥89.40 · -70%');

    steamOk = false;
    resetStoreThrottle();
    const second = await callPrice(dir, { query: '1091500', refresh: true });
    expect(second).toContain('刷新没成功,先用本地缓存');
    expect(second).toContain('¥89.40');
  });
});

describe('steam_price:地区与免费', () => {
  it('换了地区不会复用另一个区的缓存', async () => {
    let currency = 'CNY';
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;
      if (url.includes('appdetails')) {
        return json({
          '413150': {
            success: true,
            data: {
              price_overview:
                currency === 'CNY'
                  ? { currency: 'CNY', initial: 4800, final: 4800, discount_percent: 0 }
                  : { currency: 'USD', initial: 1499, final: 1499, discount_percent: 0 },
            },
          },
        });
      }
      if (url.includes('/games/lookup/v1')) return json({ found: true, game: { id: 'uuid-sdv' } });
      if (url.includes('/games/prices/v3')) {
        return json([
          {
            historyLow: { all: { amount: 14.99, currency: currency === 'CNY' ? 'CNY' : 'USD' } },
            deals: [{ shop: { name: 'Steam' }, price: { amount: currency === 'CNY' ? 48 : 14.99, currency } , cut: 0 }],
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cn = await callPrice(dir, { query: '413150' }, 'CN');
    expect(cn).toContain('CN 现价:¥48.00');

    currency = 'USD';
    resetStoreThrottle();
    const us = await callPrice(dir, { query: '413150' }, 'US');
    expect(us).toContain('US 现价:$14.99');
    expect(us).not.toContain('¥48.00');
  });

  it('ITAD 里 Steam 那条是 0 元 → 判免费,且不谈史低', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response;
      if (url.includes('appdetails')) throw new Error('store blocked');
      if (url.includes('/games/lookup/v1')) return json({ found: true, game: { id: 'uuid-cs2' } });
      if (url.includes('/games/prices/v3')) {
        return json([
          {
            historyLow: { all: { amount: 14.99, currency: 'CNY' } },
            deals: [{ shop: { name: 'Steam' }, price: { amount: 0, currency: 'CNY' }, cut: 0 }],
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const text = await callPrice(dir, { query: '730' }, 'CN');
    expect(text).toContain('Steam:免费游戏');
    expect(text).toContain('免费游戏,历史低价没有参考意义');
    expect(text).not.toContain('ITAD 记录的是 ¥0.00');
  });
});
