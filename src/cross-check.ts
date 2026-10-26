/**
 * 三方对账:Steam 注册表说在玩什么、进程表里有没有真在跑、那个进程有没有可见的主窗口。
 *
 * 为什么需要:Steam 的 RunningAppID 是客户端自己写的,退出游戏后可能残留一阵,
 * 甚至能停在上一次的值。单看它会把「刚才玩过」当成「正在玩」。
 *
 * 三份证据全部取自本机:一次 PowerShell 调用同时读注册表、枚举 steamapps 下的进程、
 * 并为这几个进程取主窗口句柄。不连任何后台服务,不装任何外部程序。
 *
 * 判定:
 *   confirmed  注册表 + 进程 + 主窗口 都对上 → 确实在玩
 *   likely     注册表 + 进程,但进程没有可见主窗口 → 大概在玩(刚启动/加载中/窗口交给子进程)
 *   stale      注册表说有,进程表里没有 → 残留,可能刚退出
 *   outside    注册表没记,但游戏进程在跑 → 不是从 Steam 启动的
 *   idle       都没在玩
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readLibraryFolders } from './steam-local.ts';

/** 明显不是「游戏本体」的进程,排除掉。 */
const HELPER_EXE = /^(msedgewebview2|crashpad_handler|crashreportclient|steamerrorreporter|unitycrashhandler(32|64)?|easyanticheat.*|be(service|game).*|battleye.*|dxsetup|vcredist.*|dotnet.*|installer|unins\d*|setup)\.exe$/i;

/** 这些目录下的进程是运行时/依赖,不算游戏本体。 */
const HELPER_DIRS = /[\\/](webview2|_commonredist|redist|installers?|dotnet|vcredist|easyanticheat|battleye|crashpad|logs?)[\\/]/i;

/** 进程路径里库根与游戏安装目录的分界。 */
const COMMON_MARK = '\\steamapps\\common\\';

export interface GameProcess {
  appid: string;
  exe: string;
  pid: number;
  path: string;
  /** 主窗口句柄;0 = 没有可见的顶层窗口 */
  hwnd: number;
  /** 主窗口标题;大多数游戏不设标题,为空串 */
  title: string;
}

export type Verdict = 'confirmed' | 'likely' | 'stale' | 'outside' | 'idle';

export interface CrossCheck {
  verdict: Verdict;
  /** 注册表里的 appid,''=没在玩 */
  registryAppId: string;
  /** 进程表里找到的游戏进程 */
  processes: GameProcess[];
  /** processes 里有可见主窗口的那些 */
  windows: GameProcess[];
  /** 人话解释,给模型看 */
  reason: string;
}

/** 一次 PowerShell 拿注册表 + steamapps 下的进程 + 这些进程的主窗口。结果缓存 5 秒。 */
interface ScanCache {
  at: number;
  registryAppId: string;
  processes: GameProcess[];
}

let cache: ScanCache | null = null;
const CACHE_MS = 5_000;

/** 从可执行文件路径里抠出 `<库>/steamapps/common/<installdir>/...` 的 installdir(小写)。 */
function installDirOf(exePath: string): string {
  const lower = exePath.toLowerCase();
  const at = lower.indexOf(COMMON_MARK);
  if (at < 0) return '';
  return lower.slice(at + COMMON_MARK.length).split('\\')[0] ?? '';
}

function scan(steamPath: string): ScanCache {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;

  const empty: ScanCache = { at: Date.now(), registryAppId: '', processes: [] };
  if (process.platform !== 'win32' || !steamPath) {
    cache = empty;
    return empty;
  }

  // 用 Get-CimInstance 而不是 Get-Process|Where:实测 314ms vs 3972ms,差 12 倍。
  // 主窗口只有 Get-Process 有,但只对上面筛出来的几个 pid 问,不扫全表。
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$s=Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam'",
    "$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\steamapps\\common\\*' } | Select-Object ProcessId,Name,ExecutablePath",
    "$procs=@(foreach($x in @($p)){ $g=Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; $hw=0; $ti=''; if($g){ $hw=[int64]$g.MainWindowHandle; $ti=[string]$g.MainWindowTitle }; [pscustomobject]@{pid=$x.ProcessId;exe=$x.Name;path=$x.ExecutablePath;hw=$hw;ti=$ti} })",
    '[pscustomobject]@{appid=$s.RunningAppID;procs=$procs} | ConvertTo-Json -Compress -Depth 4',
  ].join(';');

  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    if (!out) {
      cache = empty;
      return empty;
    }
    const parsed = JSON.parse(out) as {
      appid?: number | string;
      procs?: Array<{ pid?: number; exe?: string; path?: string; hw?: number; ti?: string }> | { pid?: number; exe?: string; path?: string; hw?: number; ti?: string };
    };
    const list = Array.isArray(parsed.procs) ? parsed.procs : parsed.procs ? [parsed.procs] : [];
    const appid = String(parsed.appid ?? '0');

    // installdir → appid:要覆盖所有库目录,游戏不一定装在主库
    const dirToApp = readInstallDirs(steamPath);
    const processes: GameProcess[] = [];
    for (const item of list) {
      const exePath = item.path ?? '';
      // 注意:PowerShell 的 ProcessName 不带 .exe,统一补上再比对
      const raw = (item.exe ?? basename(exePath)).toLowerCase();
      const exe = raw.endsWith('.exe') ? raw : `${raw}.exe`;
      if (!exePath || HELPER_EXE.test(exe)) continue;
      if (HELPER_DIRS.test(exePath)) continue;
      const installdir = installDirOf(exePath);
      const mapped = installdir ? dirToApp.get(installdir) : undefined;
      if (!mapped) continue;
      processes.push({
        appid: mapped,
        exe,
        pid: Number(item.pid ?? 0),
        path: exePath,
        hwnd: Number(item.hw ?? 0),
        title: String(item.ti ?? ''),
      });
    }

    cache = { at: Date.now(), registryAppId: appid === '0' ? '' : appid, processes };
    return cache;
  } catch {
    cache = empty;
    return empty;
  }
}

/** installdir(小写) → appid,覆盖 libraryfolders.vdf 里列出的每个库。 */
function readInstallDirs(steamPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const lib of readLibraryFolders(steamPath)) {
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
        const dir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1];
        if (dir) out.set(dir.toLowerCase(), appid);
      } catch {
        // 单个读不了就跳过
      }
    }
  }
  return out;
}

/**
 * 判定:只看两份证据(注册表、进程),主窗口是进程的属性。
 * 单独抽出来是为了能离线测,不需要真的开一个游戏。
 */
export function judge(registryAppId: string, processes: GameProcess[]): { verdict: Verdict; windows: GameProcess[]; reason: string } {
  const windows = processes.filter((item) => item.hwnd > 0);

  if (!registryAppId) {
    if (processes.length > 0) {
      const exes = [...new Set(processes.map((item) => item.exe))].join(', ');
      const win = windows.length > 0 ? `,其中 ${windows.length} 个有可见主窗口` : '';
      return {
        verdict: 'outside',
        windows,
        reason: `Steam 没记在玩,但 ${processes.length} 个游戏进程在跑(${exes}${win})——可能是从 Steam 外面启动的。`,
      };
    }
    return { verdict: 'idle', windows, reason: 'Steam 没在玩,也没发现游戏进程。' };
  }

  const target = processes[0];
  if (!target) {
    return {
      verdict: 'stale',
      windows: [],
      reason: `Steam 记录 ${registryAppId},但进程表里没有对应进程——很可能是退出后残留的值,不是真的在玩。`,
    };
  }

  if (windows.length > 0) {
    const hit = windows[0];
    const title = hit.title ? `,标题「${hit.title}」` : '';
    return {
      verdict: 'confirmed',
      windows,
      reason: `三方都对上:Steam 记录 ${registryAppId},进程 ${hit.exe} 在跑(pid ${hit.pid}),它的主窗口也在(句柄 ${hit.hwnd}${title})。`,
    };
  }

  return {
    verdict: 'likely',
    windows,
    reason: `Steam 记录 ${registryAppId},进程 ${target.exe} 确实在跑(pid ${target.pid});但它现在没有可见的主窗口——可能刚启动、还在加载,或者窗口在别的进程里。`,
  };
}

export interface CrossCheckInput {
  steamPath: string;
  /** 注册表里的 appid(调用方已经读过也可以直接给) */
  registryAppId: string;
}

/** 跑一次对账。只读本机数据,不发网络请求。 */
export function crossCheck(input: CrossCheckInput): CrossCheck {
  const scanned = scan(input.steamPath);
  const registryAppId = input.registryAppId || scanned.registryAppId;

  // 注册表说有游戏,就以它为准挑进程;否则看进程表里任意一款
  const processes = registryAppId
    ? scanned.processes.filter((item) => item.appid === registryAppId)
    : scanned.processes;

  const { verdict, windows, reason } = judge(registryAppId, processes);
  return { verdict, registryAppId, processes, windows, reason };
}

/** 让外部可以清掉缓存(测试用)。 */
export function resetScanCache(): void {
  cache = null;
}

/**
 * 这个 appid 的游戏进程现在是否真的在跑。
 * 走同一份 5 秒缓存的扫描,所以每 3 秒问一次也不会真的去扫全表。
 */
export function hasProcessFor(steamPath: string, appid: string): boolean {
  if (!appid) return false;
  return scan(steamPath).processes.some((item) => item.appid === appid);
}
