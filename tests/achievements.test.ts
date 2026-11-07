import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateAppIds,
  newUnlocks,
  snapshotOf,
  sortByRarity,
} from '../src/achievements.ts';
import { rarityTier, type AchievementItem } from '../src/steam-local.ts';

/** 造一条成就;默认已解锁且带解锁时间与完成率。 */
function item(patch: Partial<AchievementItem> = {}): AchievementItem {
  return {
    id: 'ACH_A',
    name: 'A',
    description: '',
    achieved: true,
    hidden: false,
    unlockedAt: 1_700_000_000_000,
    rarity: 3,
    ...patch,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一个带 librarycache 的假 Steam 目录。 */
function fakeSteam(appids: string[]): { steamPath: string; accountId: string } {
  const steamPath = mkdtempSync(join(tmpdir(), 'steam-ach-'));
  dirs.push(steamPath);
  const accountId = '123456789';
  const cache = join(steamPath, 'userdata', accountId, 'config', 'librarycache');
  mkdirSync(cache, { recursive: true });
  for (const appid of appids) {
    writeFileSync(
      join(cache, `${appid}.json`),
      JSON.stringify([['achievements', { data: { vecHighlight: [], vecUnachieved: [], nTotal: 1, nAchieved: 0 } }]]),
      'utf8',
    );
  }
  return { steamPath, accountId };
}

describe('rarityTier', () => {
  it('按全服完成率分档,越小越稀有', () => {
    expect(rarityTier(0.4)).toBe('legendary');
    expect(rarityTier(0.99)).toBe('legendary');
    expect(rarityTier(1)).toBe('epic');
    expect(rarityTier(4.9)).toBe('epic');
    expect(rarityTier(5)).toBe('rare');
    expect(rarityTier(14.9)).toBe('rare');
    expect(rarityTier(15)).toBe('uncommon');
    expect(rarityTier(34.9)).toBe('uncommon');
    expect(rarityTier(35)).toBe('common');
    expect(rarityTier(90)).toBe('common');
  });

  it('缓存没给完成率(0 或非数字)算 unknown,不当成稀有', () => {
    expect(rarityTier(0)).toBe('unknown');
    expect(rarityTier(Number.NaN)).toBe('unknown');
  });
});

describe('snapshotOf', () => {
  it('只留已解锁的,键是成就 id', () => {
    const snap = snapshotOf([
      item({ id: 'A' }),
      item({ id: 'B', achieved: false }),
      item({ id: 'C', achieved: true, unlockedAt: 1_600_000_000_000 }),
    ]);
    expect(snap.has('A')).toBe(true);
    expect(snap.has('B')).toBe(false);
    expect(snap.get('C')).toBe(1_600_000_000_000);
  });
});

describe('newUnlocks', () => {
  const now = 1_700_000_100_000;
  const maxAgeMs = 10 * 60_000;

  it('第一次看这款(没有基线)不报任何东西', () => {
    const fresh = newUnlocks('570', 'Dota', [item()], undefined, now, maxAgeMs);
    expect(fresh).toEqual([]);
  });

  it('基线里没有、且刚刚解锁的才算新解锁', () => {
    const baseline = new Map([['OLD', 0]]) as unknown as ReturnType<typeof snapshotOf>;
    baseline.set('OLD', 1_600_000_000_000);
    const fresh = newUnlocks(
      '570',
      'Dota',
      [item({ id: 'OLD', unlockedAt: 1_600_000_000_000 }), item({ id: 'NEW', unlockedAt: now - 60_000 })],
      baseline,
      now,
      maxAgeMs,
    );
    expect(fresh.map((f) => f.id)).toEqual(['NEW']);
    expect(fresh[0].tier).toBe('epic');
    expect(fresh[0].gameName).toBe('Dota');
  });

  it('解锁时间太老的补报不算新闻(防止换机/清缓存后一次推一堆)', () => {
    const baseline = new Map() as ReturnType<typeof snapshotOf>;
    const fresh = newUnlocks('570', 'Dota', [item({ id: 'NEW', unlockedAt: now - 3 * 24 * 3600_000 })], baseline, now, maxAgeMs);
    expect(fresh).toEqual([]);
  });

  it('未解锁的不报', () => {
    const fresh = newUnlocks('570', 'Dota', [item({ id: 'NEW', achieved: false })], new Map(), now, maxAgeMs);
    expect(fresh).toEqual([]);
  });

  it('已解锁但没有解锁时间的也不报(否则每次建基线都会重播历史成就)', () => {
    const fresh = newUnlocks('570', 'Dota', [item({ id: 'NEW', unlockedAt: 0 })], new Map(), now, maxAgeMs);
    expect(fresh).toEqual([]);
  });
});

describe('sortByRarity', () => {
  it('完成率小的在前;没给完成率的排最后', () => {
    const sorted = sortByRarity([
      { rarity: 45 },
      { rarity: 0 },
      { rarity: 2 },
      { rarity: 12 },
    ]);
    expect(sorted.map((s) => s.rarity)).toEqual([2, 12, 45, 0]);
  });
});

describe('candidateAppIds', () => {
  it('正在玩的 appid 一定在里面', () => {
    const { steamPath, accountId } = fakeSteam([]);
    expect(candidateAppIds(steamPath, accountId, '570', 10 * 60_000)).toEqual(['570']);
  });

  it('最近改动过的缓存文件也算进候选', () => {
    const { steamPath, accountId } = fakeSteam(['730', '440']);
    const cache = join(steamPath, 'userdata', accountId, 'config', 'librarycache');
    const old = new Date(Date.now() - 5 * 24 * 3600_000);
    utimesSync(join(cache, '440.json'), old, old);
    const ids = candidateAppIds(steamPath, accountId, '', 10 * 60_000);
    expect(ids).toEqual(['730']);
  });

  it('没有账号或目录不存在时返回空,不抛错', () => {
    const { steamPath } = fakeSteam([]);
    expect(candidateAppIds(steamPath, '', '', 10 * 60_000)).toEqual([]);
    expect(candidateAppIds('E:\\no-such-steam', '123', '570', 10 * 60_000)).toEqual(['570']);
  });
});