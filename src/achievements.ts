/**
 * 成就解锁检测:比对两次快照,找出「这次新解锁的」条目。
 *
 * 为什么需要快照:Steam 只在**退出游戏或切换游戏时**把成就写回
 * `librarycache/<appid>.json`,所以「解锁那一刻」本地根本看不到。
 * 只能靠定期比对快照,把两次之间新出现的 `rtUnlocked` 认出来。
 *
 * 全部读本地文件,不需要 API key —— 稀有度就是缓存里的 `flAchieved`。
 */
import { existsSync, readFileSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs';
import { join } from 'node:path';
import { rarityTier, readGameAchievements, type AchievementItem, type RarityTier } from './steam-local.ts';

/** 一条已解锁的成就(带稀有度)。 */
export interface UnlockedAchievement {
  appid: string;
  gameName: string;
  id: string;
  name: string;
  /** 解锁时间(epoch ms) */
  unlockedAt: number;
  /** 全服完成率;0=缓存没给 */
  rarity: number;
  tier: RarityTier;
}

/**
 * 增量检测要看哪几款游戏:
 * 正在玩的这一款,加上最近 `withinMs` 内写过成就缓存的(退出时才写回的那批)。
 */
export function candidateAppIds(steamPath: string, accountId: string, runningAppId: string, withinMs: number): string[] {
  const out: string[] = [];
  if (runningAppId && /^\d+$/.test(runningAppId)) out.push(runningAppId);
  if (!accountId) return out;

  const dir = join(steamPath, 'userdata', accountId, 'config', 'librarycache');
  if (!existsSync(dir)) return out;

  // 只要「最近改动过」的 appid
  let names: string[] = [];
  try {
    names = fsReaddirSync(dir);
  } catch {
    return out;
  }
  const since = Date.now() - withinMs;
  for (const name of names) {
    const appid = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!appid || !/^\d+$/.test(appid)) continue;
    if (out.includes(appid)) continue;
    try {
      if (fsStatSync(join(dir, name)).mtimeMs >= since) out.push(appid);
    } catch {
      // 读不到就跳过
    }
  }
  return out;
}

/** 一款游戏此刻的快照:只留已解锁的,键是成就 id。 */
export type AchievementSnapshot = Map<string, number>;

/** 已解锁条目 → 快照(id → unlockedAt)。 */
export function snapshotOf(items: readonly AchievementItem[]): AchievementSnapshot {
  const out: AchievementSnapshot = new Map();
  for (const item of items) {
    if (item.achieved && item.id) out.set(item.id, item.unlockedAt);
  }
  return out;
}

/**
 * 比对前后两份快照,返回新解锁的条目。
 *
 * `baseline` 缺席(第一次看这款)时不报任何东西 —— 否则首次挂载会把
 * 历史上所有成就当成「刚解锁」,一次推几十条事件。
 */
export function newUnlocks(
  appid: string,
  gameName: string,
  items: readonly AchievementItem[],
  baseline: AchievementSnapshot | undefined,
  now: number,
  maxAgeMs: number,
): UnlockedAchievement[] {
  if (!baseline) return [];
  const out: UnlockedAchievement[] = [];
  for (const item of items) {
    if (!item.achieved || !item.id) continue;
    if (baseline.has(item.id)) continue;              // 以前就有
    // 必须带解锁时间:缺了就没法判断是不是「刚解锁」的,
    // 当成新闻会在每次建基线后反复重播历史成就
    if (item.unlockedAt <= 0) continue;
    // 只认「刚刚解锁」的:缓存写回有延迟,但太老的不要当成新闻
    if (now - item.unlockedAt > maxAgeMs) continue;
    out.push({
      appid,
      gameName,
      id: item.id,
      name: item.name || item.id,
      unlockedAt: item.unlockedAt,
      rarity: item.rarity,
      tier: rarityTier(item.rarity),
    });
  }
  return out;
}

/** 按稀有度排序:越稀有越靠前(完成率小的在前)。 */
export function sortByRarity<T extends { rarity: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = a.rarity > 0 ? a.rarity : 101;
    const rb = b.rarity > 0 ? b.rarity : 101;
    return ra - rb;
  });
}

/** 读一款游戏的已解锁快照;读不到返回空表。 */
export function readSnapshot(steamPath: string, accountId: string, appid: string): AchievementSnapshot {
  const detail = readGameAchievements(steamPath, accountId, appid);
  return detail ? snapshotOf(detail.items) : new Map();
}

/** 读一款游戏的成就条目;读不到返回 null。 */
export function readItems(steamPath: string, accountId: string, appid: string): AchievementItem[] | null {
  const detail = readGameAchievements(steamPath, accountId, appid);
  return detail ? detail.items : null;
}

/** 缓存文件里是否还留着这份明细(有些游戏不写)。 */
export function hasCache(steamPath: string, accountId: string, appid: string): boolean {
  if (!accountId || !/^\d+$/.test(appid)) return false;
  return existsSync(join(steamPath, 'userdata', accountId, 'config', 'librarycache', `${appid}.json`));
}

/** 读 JSON 原文,只给测试与排错用。 */
export function peekRaw(steamPath: string, accountId: string, appid: string): string | null {
  if (!hasCache(steamPath, accountId, appid)) return null;
  try {
    return readFileSync(join(steamPath, 'userdata', accountId, 'config', 'librarycache', `${appid}.json`), 'utf8');
  } catch {
    return null;
  }
}