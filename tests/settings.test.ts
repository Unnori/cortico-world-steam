import { describe, expect, it } from 'vitest';
import { ITAD_SECRET_NAME, STEAM_SECRET_NAME, invokeSteamPanel, keyState } from '../src/settings.ts';

function makeDeps(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    deps: {
      secret: (name: string) => store.get(name) ?? '',
      storeSecret: (name: string, value: string) => {
        store.set(name, value);
      },
      envFile: () => '',
    },
  };
}

describe('面板:两个 key 的状态', () => {
  it('未配置时两个都是 false,并带各自的申请地址', () => {
    const { deps } = makeDeps();
    const state = keyState(deps);
    expect(state.steam.configured).toBe(false);
    expect(state.itad.configured).toBe(false);
    expect(state.steam.applyUrl).toContain('steamcommunity.com');
    expect(state.itad.applyUrl).toContain('isthereanydeal.com');
  });

  it('已配置时只回掩码,不回明文', () => {
    const { deps } = makeDeps({ [STEAM_SECRET_NAME]: 'A'.repeat(32), [ITAD_SECRET_NAME]: 'abcdefghijklmnop1234' });
    const state = keyState(deps);
    expect(state.steam.masked).toBe('AAAA…AAAA');
    expect(JSON.stringify(state)).not.toContain('A'.repeat(32));
  });
});

describe('面板:保存与校验', () => {
  it('Steam key 必须是 32 位十六进制', () => {
    const { deps } = makeDeps();
    const bad = invokeSteamPanel(deps, 'save', ['not-a-key']);
    expect('error' in bad).toBe(true);
    const good = invokeSteamPanel(deps, 'save', ['f'.repeat(32)]);
    expect('error' in good).toBe(false);
    if (!('error' in good)) expect(good.steam.configured).toBe(true);
  });

  it('ITAD key 走 save-itad,写进 ITAD_API_KEY', () => {
    const { deps, store } = makeDeps();
    const bad = invokeSteamPanel(deps, 'save-itad', ['short']);
    expect('error' in bad).toBe(true);
    const good = invokeSteamPanel(deps, 'save-itad', ['abcd1234efgh5678ijkl']);
    expect('error' in good).toBe(false);
    expect(store.get(ITAD_SECRET_NAME)).toBe('abcd1234efgh5678ijkl');
  });

  it('没有 .env 时清除会给出可读错误,而不是崩', () => {
    const { deps } = makeDeps({ [ITAD_SECRET_NAME]: 'abcd1234efgh5678ijkl' });
    const out = invokeSteamPanel(deps, 'clear-itad', []);
    expect('error' in out).toBe(true);
  });

  it('未知方法返回错误', () => {
    const { deps } = makeDeps();
    expect('error' in invokeSteamPanel(deps, 'nope', [])).toBe(true);
  });
});
