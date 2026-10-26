/**
 * Steam 本地数据读取。
 *
 * 来源:
 *  - 注册表 HKCU\Software\Valve\Steam 的 RunningAppID / ActiveUser → 现在在玩什么
 *  - userdata/<账号ID>/config/localconfig.vdf 的 apps 段 → 每个游戏的 Playtime(分钟) / LastPlayed
 *  - steamapps/appmanifest_<appid>.acf → 已安装游戏的名字
 *  - userdata/<账号ID>/config/librarycache/achievement_progress.json → 成就进度缓存
 *  - config/loginusers.vdf → 这台机器登录过的账号:SteamID64 + 昵称(不需要 key)
 *
 * localconfig.vdf 里**没有游戏名**,只有 appid;未安装过的游戏名字要靠 Steam Web API 补。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface SteamConfig {
  /** Steam 安装目录,如 E:\Steam;留空自动找 */
  steamPath: string;
  /** 当前登录的 SteamID64;留空从注册表读 */
  steamId: string;
  /** Steam Web API key;没有就只给本地能拿到的 */
  apiKey: string;
  timeoutMs: number;
}

export interface AppRecord {
  appid: string;
  /** 游戏名;本地没有就是空串 */
  name: string;
  /** 累计游玩分钟 */
  playtime: number;
  /** 最后游玩时间(epoch ms),0=没有 */
  lastPlayed: number;
  /** 是否已安装 */
  installed: boolean;
  /** 成就进度 */
  achievements?: { unlocked: number; total: number; percentage: number; allUnlocked: boolean };
}

export interface RunningState {
  /** 正在玩的 appid;'0' 或空表示没在玩 */
  appid: string;
  steamPid: number;
  activeUser: string;
}

/**
 * 读注册表里的 Steam 状态。只支持 Windows。
 *
 * 用 `reg query` 而不是 PowerShell:实测 76ms vs 398ms,主动检测每几秒跑一次,这个差距很要紧。
 */
export function readRegistry(): RunningState {
  const fallback: RunningState = { appid: '0', steamPid: 0, activeUser: '' };
  if (process.platform !== 'win32') return fallback;
  try {
    const readDword = (key: string, value: string): string => {
      const out = execFileSync('reg', ['query', key, '/v', value], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      // 形如:    RunningAppID    REG_DWORD    0x431124
      const match = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
      return match ? String(parseInt(match[1], 16)) : '';
    };
    const appid = readDword('HKCU\\Software\\Valve\\Steam', 'RunningAppID');
    const user = readDword('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser');
    const pid = readDword('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'pid');
    return {
      appid: appid || '0',
      steamPid: pid ? Number(pid) : 0,
      activeUser: user || '',
    };
  } catch {
    return fallback;
  }
}

/** 猜 Steam 安装目录。 */
export function detectSteamPath(cfg: SteamConfig): string {
  if (cfg.steamPath && cfg.steamPath.trim()) return cfg.steamPath.trim();
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath"],
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      ).trim();
      if (out) return out.replace(/\//g, '\\');
    } catch {
      // 落到底下几个常见路径
    }
  }
  for (const guess of ['C:\\Program Files (x86)\\Steam', 'C:\\Steam', 'D:\\Steam', 'E:\\Steam']) {
    if (existsSync(join(guess, 'steam.exe'))) return guess;
  }
  return '';
}

/**
 * 当前登录用户,**32 位账号 ID**(就是 `userdata/<id>` 的目录名)。
 *
 * 注意:这不是 SteamID64。Web API 要的是 64 位,换算见 toSteamId64()。
 */
export function detectSteamId(cfg: SteamConfig, steamPath: string): string {
  if (cfg.steamId && cfg.steamId.trim()) return cfg.steamId.trim();
  const reg = readRegistry();
  if (reg.activeUser && reg.activeUser !== '0') return reg.activeUser;
  const userdata = join(steamPath, 'userdata');
  if (existsSync(userdata)) {
    const dirs = readdirSync(userdata).filter((name) => /^\d{6,}$/.test(name));
    if (dirs.length === 1) return dirs[0];
    if (dirs.length > 1) {
      // 取最近改过的那个
      let best = dirs[0];
      let bestTime = 0;
      for (const dir of dirs) {
        try {
          const t = statSync(join(userdata, dir)).mtimeMs;
          if (t > bestTime) {
            bestTime = t;
            best = dir;
          }
        } catch {
          // 跳过读不到的
        }
      }
      return best;
    }
  }
  return '';
}

/** SteamID64 与 32 位账号 ID 的差,只对个人账号(universe=1)成立。超过 2^53,必须用 BigInt。 */
const STEAM_ID64_BASE = 76561197960265728n;

/**
 * 64 位 SteamID → 32 位账号 ID(userdata 目录名用这个)。
 * 本来就是 32 位的原样返回;不是纯数字的(比如自定义的昵称)也原样返回,让上层自己兜底。
 */
export function toAccountId(id: string): string {
  const text = (id ?? '').trim();
  if (!/^\d+$/.test(text)) return text;
  if (text.length < 17) return text;
  const diff = BigInt(text) - STEAM_ID64_BASE;
  return diff > 0n ? diff.toString() : text;
}

/**
 * 32 位账号 ID → 64 位 SteamID(Web API 要这个)。
 * 已经是 64 位的原样返回;不是纯数字的返回空串,调用方据此跳过联网。
 */
export function toSteamId64(id: string): string {
  const text = (id ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  if (text.length >= 17) return text;
  return (STEAM_ID64_BASE + BigInt(text)).toString();
}

/**
 * 极简 VDF 解析:只需要从 localconfig.vdf 的 apps 段里抠出每个 appid 的
 * Playtime / LastPlayed。不追求通用,只认这一种形状。
 */
export function parsePlaytimes(text: string): Map<string, { playtime: number; lastPlayed: number }> {
  const out = new Map<string, { playtime: number; lastPlayed: number }>();

  // 先定位 "apps" { ... } 段(用括号配平,别被嵌套块骗了)
  const appsAt = text.search(/"apps"\s*\{/);
  if (appsAt < 0) return out;
  const braceStart = text.indexOf('{', appsAt);
  let depth = 0;
  let end = text.length;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const section = text.slice(braceStart + 1, end);

  // 在 apps 段里逐块扫 "appid" { ... }
  const re = /"(\d{2,8})"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(section)) !== null) {
    const appid = match[1];
    const bodyStart = match.index + match[0].length - 1;
    let d = 0;
    let bodyEnd = section.length;
    for (let i = bodyStart; i < section.length; i += 1) {
      if (section[i] === '{') d += 1;
      else if (section[i] === '}') {
        d -= 1;
        if (d === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const body = section.slice(bodyStart, bodyEnd);
    const playtime = /"Playtime"\s+"(\d+)"/.exec(body);
    const lastPlayed = /"LastPlayed"\s+"(\d+)"/.exec(body);
    if (playtime) {
      out.set(appid, {
        playtime: Number(playtime[1]),
        lastPlayed: lastPlayed ? Number(lastPlayed[1]) * 1000 : 0,
      });
    }
    re.lastIndex = bodyEnd;
  }
  return out;
}

/** 已安装游戏:appid → 名字 / 安装目录。 */
export function readInstalled(steamPath: string): Map<string, { name: string; dir: string }> {
  const out = new Map<string, { name: string; dir: string }>();
  const libs = readLibraryFolders(steamPath);
  for (const lib of libs) {
    const apps = join(lib, 'steamapps');
    if (!existsSync(apps)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(apps).filter((name) => name.startsWith('appmanifest_') && name.endsWith('.acf'));
    } catch {
      continue;
    }
    for (const file of files) {
      const appid = file.replace('appmanifest_', '').replace('.acf', '');
      try {
        const text = readFileSync(join(apps, file), 'utf8');
        const name = /"name"\s+"([^"]+)"/.exec(text)?.[1] ?? '';
        const dir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1] ?? '';
        if (name) out.set(appid, { name, dir });
      } catch {
        // 单个清单读不了就跳过
      }
    }
  }
  return out;
}

/** 所有库目录(含主目录)。Windows 路径不分大小写,同一个库只留第一次见到的写法。 */
export function readLibraryFolders(steamPath: string): string[] {
  const seen = new Map<string, string>();
  const add = (dir: string): void => {
    const clean = dir.replace(/[\\/]+$/, '');
    if (clean) seen.set(clean.toLowerCase(), clean);
  };
  add(steamPath);
  const file = join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8');
      const re = /"path"\s+"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) add(m[1].replace(/\\\\/g, '\\'));
    } catch {
      // 读不了就只用主目录
    }
  }
  return [...seen.values()];
}

/** 成就进度缓存:appid → {unlocked,total,...} */
export function readAchievements(steamPath: string, steamId: string): Map<string, AppRecord['achievements']> {
  const out = new Map<string, AppRecord['achievements']>();
  if (!steamId) return out;
  const file = join(steamPath, 'userdata', steamId, 'config', 'librarycache', 'achievement_progress.json');
  if (!existsSync(file)) return out;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      mapCache?: Array<[number, { appid?: number; unlocked?: number; total?: number; percentage?: number; all_unlocked?: boolean }]>;
    };
    for (const entry of parsed.mapCache ?? []) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [id, data] = entry;
      if (!data || typeof data !== 'object') continue;
      const total = Number(data.total ?? 0);
      const unlocked = Number(data.unlocked ?? 0);
      if (total <= 0) continue;
      out.set(String(id), {
        unlocked,
        total,
        percentage: Number(data.percentage ?? (unlocked / total) * 100),
        allUnlocked: data.all_unlocked === true,
      });
    }
  } catch {
    // 缓存坏了就当没有
  }
  return out;
}

/** 单条成就。 */
export interface AchievementItem {
  id: string;
  name: string;
  description: string;
  achieved: boolean;
  /** 隐藏成就:没拿到前名字/描述通常是空的 */
  hidden: boolean;
}

/** 单款游戏的成就明细。 */
export interface GameAchievements {
  unlocked: number;
  total: number;
  percentage: number;
  allUnlocked: boolean;
  /** 缓存里带回来的条目;可能不全,所以以 unlocked/total 为准 */
  items: AchievementItem[];
}

/**
 * 单款成就明细,读 `userdata/<账号>/config/librarycache/<appid>.json`。
 *
 * 为什么要有这个:`achievement_progress.json` 只是个索引,**不是每款游戏都在里面**
 * (实测就有游戏不在索引里,于是只能报 0)。而 `<appid>.json` 里
 * 有 nAchieved/nTotal 和逐条的名字、描述、解锁时间,是本地最准的一份。
 */
export function readGameAchievements(steamPath: string, steamId: string, appid: string): GameAchievements | null {
  if (!steamId || !/^\d+$/.test(appid)) return null;
  const file = join(steamPath, 'userdata', steamId, 'config', 'librarycache', `${appid}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Array<[string, any]>;
    if (!Array.isArray(parsed)) return null;
    const entry = parsed.find((row) => Array.isArray(row) && row[0] === 'achievements');
    const data = (entry?.[1] as any)?.data;
    if (!data) return null;

    const items: AchievementItem[] = [];
    const push = (list: any, achieved: boolean, hidden: boolean): void => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const id = String(item?.strID ?? '');
        if (!id) continue;
        items.push({
          id,
          name: String(item?.strName ?? ''),
          description: String(item?.strDescription ?? ''),
          achieved: typeof item?.bAchieved === 'boolean' ? item.bAchieved : achieved,
          hidden,
        });
      }
    };
    push(data.vecHighlight, true, false);      // 已解锁(高亮)
    push(data.vecUnachieved, false, false);    // 未解锁
    push(data.vecAchievedHidden, true, true);  // 隐藏且已解锁

    const countedFromItems = items.filter((item) => item.achieved).length;
    const total = Number(data.nTotal ?? 0) || items.length;
    const unlocked = Number.isFinite(Number(data.nAchieved)) && Number(data.nAchieved) > 0
      ? Number(data.nAchieved)
      : countedFromItems;
    if (total <= 0) return null;
    return {
      unlocked,
      total,
      percentage: (unlocked / total) * 100,
      allUnlocked: unlocked >= total,
      items,
    };
  } catch {
    return null;
  }
}

/** 截图:userdata/<id>/760/remote/<appid>/screenshots 下的文件数与最新时间。 */
export function readScreenshots(steamPath: string, steamId: string): Map<string, { count: number; latest: number }> {
  const out = new Map<string, { count: number; latest: number }>();
  if (!steamId) return out;
  const remote = join(steamPath, 'userdata', steamId, '760', 'remote');
  if (!existsSync(remote)) return out;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(remote);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!/^\d+$/.test(dir)) continue;
    const shots = join(remote, dir, 'screenshots');
    if (!existsSync(shots)) continue;
    try {
      const files = readdirSync(shots).filter((name) => /\.(jpg|png|jpeg)$/i.test(name));
      if (files.length === 0) continue;
      let latest = 0;
      for (const file of files) {
        try {
          const t = statSync(join(shots, file)).mtimeMs;
          if (t > latest) latest = t;
        } catch {
          // 跳过
        }
      }
      out.set(dir, { count: files.length, latest });
    } catch {
      // 跳过
    }
  }
  return out;
}

/**
 * 这台机器登录过的 Steam 账号(读 `config/loginusers.vdf`)。
 *
 * 只取 SteamID64、昵称、最近登录时间——**故意不读 AccountName**:
 * 那是登录用的账号名,比昵称敏感得多,不该进对话。
 */
export interface LoginUser {
  steamId64: string;
  personaName: string;
  /** 最近登录时间(epoch ms),0=没写 */
  lastLogin: number;
}

export function readLoginUsers(steamPath: string): LoginUser[] {
  const file = join(steamPath, 'config', 'loginusers.vdf');
  if (!existsSync(file)) return [];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const users: LoginUser[] = [];
  // 每个账号是一个 "7656119…" { … } 块
  const blockRe = /"(\d{17})"\s*\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const body = match[2];
    const persona = /"PersonaName"\s*"([^"]*)"/.exec(body)?.[1] ?? '';
    const timestamp = Number(/"timestamp"\s*"(\d+)"/.exec(body)?.[1] ?? 0);
    users.push({
      steamId64: match[1],
      personaName: persona,
      lastLogin: Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : 0,
    });
  }
  return users;
}
