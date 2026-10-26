import { describe, expect, it } from 'vitest';
import { steamTools } from '../src/tools.ts';

/** 只测不碰文件系统与网络的分支:好友开关与 key 的两道闸。 */
function toolsWith(cfg: Record<string, unknown>) {
  const tools = steamTools({
    cfg: () => ({ enabled: true, steamPath: '', steamId: '', apiKey: '', timeoutMs: 12000, pollSeconds: 3, ...cfg }),
    timezone: 'Asia/Shanghai',
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const tool = tools.find((item) => item.name === name)!;
    const out = await (tool.handler as unknown as (a: Record<string, unknown>) => Promise<string | { text: string }>)(args);
    return typeof out === 'string' ? out : out.text;
  };
  return { call, tools };
}

describe('steam_friends 的两道闸', () => {
  it('默认配置下直接拒绝,并说明去哪打开', async () => {
    const { call } = toolsWith({});
    const text = await call('steam_friends');
    expect(text).toContain('关着');
    expect(text).toContain('friendsEnabled');
  });

  it('开了开关但没配 key 时,提示要 key', async () => {
    const { call } = toolsWith({ friendsEnabled: true });
    const text = await call('steam_friends');
    expect(text).toContain('API key');
  });
});

describe('工具清单', () => {
  it('九个工具,名字都带 steam_ 前缀且不重复', () => {
    const { tools } = toolsWith({});
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(9);
    for (const name of names) expect(name.startsWith('steam_')).toBe(true);
  });

  it('每个工具都在 describe 里有一份 summary', async () => {
    const { STEAM } = await import('../src/definition.ts');
    const declared = new Set((STEAM.describe?.tools ?? []).map((tool) => tool.name));
    const { tools } = toolsWith({});
    for (const tool of tools) expect(declared.has(tool.name)).toBe(true);
  });
});
