import { describe, expect, it } from 'vitest';
import { judge, type GameProcess } from '../src/cross-check.ts';

/** 造一条进程证据;hwnd=0 表示这个进程没有可见主窗口。 */
function proc(appid: string, exe = 'game.exe', hwnd = 0): GameProcess {
  return { appid, exe, pid: 1234, path: `E:\\Steam\\steamapps\\common\\Game\\${exe}`, hwnd, title: '' };
}

describe('judge:注册表 + 进程 + 主窗口的三方对账', () => {
  it('三方都对上 → confirmed', () => {
    const result = judge('570', [proc('570', 'dota2.exe', 0x1234)]);
    expect(result.verdict).toBe('confirmed');
    expect(result.windows).toHaveLength(1);
    expect(result.reason).toContain('三方都对上');
  });

  it('注册表 + 进程,但没有可见主窗口 → likely', () => {
    const result = judge('570', [proc('570', 'dota2.exe', 0)]);
    expect(result.verdict).toBe('likely');
    expect(result.windows).toHaveLength(0);
  });

  it('只有注册表记着,进程不在 → stale(退出后的残留值)', () => {
    const result = judge('570', []);
    expect(result.verdict).toBe('stale');
  });

  it('只有进程在跑,Steam 没记 → outside(不是 Steam 启动的)', () => {
    const result = judge('', [proc('570', 'dota2.exe', 0x1234)]);
    expect(result.verdict).toBe('outside');
    expect(result.reason).toContain('dota2.exe');
  });

  it('两边都空 → idle', () => {
    expect(judge('', []).verdict).toBe('idle');
  });

  it('多个进程里只要有一个有窗口就算 confirmed', () => {
    const result = judge('570', [proc('570', 'helper.exe', 0), proc('570', 'dota2.exe', 0x42)]);
    expect(result.verdict).toBe('confirmed');
    expect(result.windows).toHaveLength(1);
  });
});
