import { describe, expect, it } from 'vitest';
import { readGameAchievements, readLoginUsers, parsePlaytimes, toAccountId, toSteamId64 } from '../src/steam-local.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtDateTime, parsePoint } from '../src/time.ts';

/** localconfig.vdf 的 apps 段:只需要 Playtime / LastPlayed。 */
const VDF = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"570"
					{
						"LastPlayed"		"1750000000"
						"Playtime"		"12345"
						"Playtime2wks"		"30"
					}
					"400"
					{
						"Playtime"		"7"
					}
					"730"
					{
						"LastPlayed"		"1760000000"
					}
				}
			}
		}
	}
}`;

describe('parsePlaytimes', () => {
  it('抠出每款游戏的时长与最后游玩时间', () => {
    const times = parsePlaytimes(VDF);
    expect(times.size).toBe(2);
    expect(times.get('570')).toEqual({ playtime: 12345, lastPlayed: 1_750_000_000_000 });
    expect(times.get('400')).toEqual({ playtime: 7, lastPlayed: 0 });
  });

  it('没有 apps 段时返回空表,不抛错', () => {
    expect(parsePlaytimes('"nope" { }').size).toBe(0);
  });
});

describe('账号 ID 与 SteamID64', () => {
  it('32 位账号 ID → 64 位 SteamID(userdata 目录名 → Web API)', () => {
    expect(toSteamId64('123456789')).toBe('76561198083722517');
  });

  it('64 位 → 32 位,且往返一致', () => {
    expect(toAccountId('76561198083722517')).toBe('123456789');
    expect(toSteamId64(toAccountId('76561198083722517'))).toBe('76561198083722517');
  });

  it('已经是 64 位的原样返回', () => {
    expect(toSteamId64('76561198083722517')).toBe('76561198083722517');
  });

  it('不是纯数字时:账号 ID 原样返回,64 位给空串(跳过联网)', () => {
    expect(toAccountId('someone')).toBe('someone');
    expect(toSteamId64('someone')).toBe('');
  });
});

describe('readLoginUsers', () => {
  it('从 loginusers.vdf 里读 SteamID64、昵称与最近登录,不碰 AccountName', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steam-login-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      join(dir, 'config', 'loginusers.vdf'),
      `"users"
{
	"76561198083722517"
	{
		"AccountName"		"secret-login-name"
		"PersonaName"		"TestPlayer"
		"timestamp"		"1792924628"
	}
	"76561198000000000"
	{
		"PersonaName"		"另一个号"
		"timestamp"		"1700000000"
	}
}
`,
      'utf8',
    );
    const users = readLoginUsers(dir);
    rmSync(dir, { recursive: true, force: true });

    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      steamId64: '76561198083722517',
      personaName: 'TestPlayer',
      lastLogin: 1_792_924_628_000,
    });
    // 登录名不该被解析进来
    expect(JSON.stringify(users)).not.toContain('secret-login-name');
  });

  it('文件不存在时返回空数组', () => {
    expect(readLoginUsers('E:\\definitely-not-a-steam-dir')).toEqual([]);
  });
});

describe('parsePoint', () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);

  it('认 YYYY-MM-DD', () => {
    expect(fmtDateTime(parsePoint('2026-10-01', now, 'Asia/Shanghai')!, 'Asia/Shanghai')).toBe('2026-10-01 00:00');
  });

  it('认相对时刻 HH:mm(当天)', () => {
    expect(fmtDateTime(parsePoint('08:30', now, 'Asia/Shanghai')!, 'Asia/Shanghai')).toBe('2026-10-26 08:30');
  });

  it('认 7d / 12h / 2w 这种相对写法', () => {
    expect(parsePoint('7d', now, 'Asia/Shanghai')).toBe(now - 7 * 86_400_000);
    expect(parsePoint('12h', now, 'Asia/Shanghai')).toBe(now - 12 * 3_600_000);
    expect(parsePoint('2w', now, 'Asia/Shanghai')).toBe(now - 14 * 86_400_000);
  });

  it('垃圾输入返回 null', () => {
    expect(parsePoint('昨天', now, 'Asia/Shanghai')).toBeNull();
    expect(parsePoint('7m', now, 'Asia/Shanghai')).toBeNull();
  });
});

describe('readGameAchievements', () => {
  it('从 librarycache/<appid>.json 读出计数与逐条名字', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steam-ach-'));
    mkdirSync(join(dir, 'userdata', '123456789', 'config', 'librarycache'), { recursive: true });
    writeFileSync(
      join(dir, 'userdata', '123456789', 'config', 'librarycache', '413150.json'),
      JSON.stringify([
        [
          'achievements',
          {
            version: 2,
            data: {
              vecHighlight: [
                { strID: 'ACH_A', strName: 'Mirror, Mirror', strDescription: 'You look amazing!', bAchieved: true },
              ],
              vecUnachieved: [
                { strID: 'ACH_B', strName: 'Escape Together', strDescription: 'Complete any room in co-op' },
              ],
              vecAchievedHidden: [{ strID: 'ACH_H', strName: 'Secret', strDescription: '', bAchieved: true }],
              nTotal: 25,
              nAchieved: 12,
            },
          },
        ],
      ]),
      'utf8',
    );

    const result = readGameAchievements(dir, '123456789', '413150');
    rmSync(dir, { recursive: true, force: true });

    expect(result).toMatchObject({ unlocked: 12, total: 25, allUnlocked: false });
    expect(result?.percentage).toBeCloseTo(48, 0);
    expect(result?.items).toHaveLength(3);
    expect(result?.items.find((item) => item.id === 'ACH_B')).toMatchObject({ achieved: false, hidden: false });
    expect(result?.items.find((item) => item.id === 'ACH_H')).toMatchObject({ achieved: true, hidden: true });
  });

  it('文件不存在时返回 null', () => {
    expect(readGameAchievements('E:////no-such-steam', '123456789', '413150')).toBeNull();
  });

  it('非数字 appid 直接拒绝,不去拼路径', () => {
    expect(readGameAchievements('E:////Steam', '123456789', '../etc')).toBeNull();
  });
});
