/**
 * 两个 key 的面板:Steam Web API key + IsThereAnyDeal API key。
 *
 * 密钥不进 config.json:走宿主的 secret() / storeSecret(),值落在部署的 .env 里
 * (STEAM_API_KEY / ITAD_API_KEY)。面板只回「配没配」与掩码,不回明文。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConfigGroup } from 'cortico/core/types.ts';

/** Steam Web API key 在部署 .env 里的变量名。 */
export const STEAM_SECRET_NAME = 'STEAM_API_KEY';
/** ITAD API key 在部署 .env 里的变量名(价格史低用)。 */
export const ITAD_SECRET_NAME = 'ITAD_API_KEY';

/** 面板 id,和 webUi().panels 里的声明一致。 */
export const STEAM_PANEL_ID = 'apikey';

const STEAM_APPLY_URL = 'https://steamcommunity.com/dev/apikey';
const ITAD_APPLY_URL = 'https://isthereanydeal.com/apps/my/';

export interface SteamPanelDeps {
  secret: (name: string) => string;
  storeSecret: (name: string, value: string) => void;
  /** 部署 .env 的绝对路径,清除密钥时要直接改它 */
  envFile: () => string;
}

/**
 * 从 .env 里删掉某个变量。
 * 宿主的 storeSecret 不接受空值,所以清除只能自己动手。
 */
function removeEnvLine(file: string, name: string): boolean {
  if (!file) return false;
  try {
    if (!existsSync(file)) return false;
    const text = readFileSync(file, 'utf8');
    const pattern = new RegExp(`^[ \\t]*${name}\\s*=.*$`, 'm');
    if (!pattern.test(text)) return false;
    const next = text.replace(pattern, '').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '');
    writeFileSync(file, next, 'utf8');
    // 进程环境里也清掉,免得 secret() 还读到旧值
    delete process.env[name];
    return true;
  } catch {
    return false;
  }
}

/** 单个 key 的状态:只给「有没有」,不给值。 */
export interface KeyState {
  configured: boolean;
  /** 掩码形式,让操作者能认出来是哪一把 */
  masked: string;
  /** 申请地址 */
  applyUrl: string;
}

export interface ApiKeyState {
  steam: KeyState;
  itad: KeyState;
}

function mask(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function stateOf(deps: SteamPanelDeps, name: string, applyUrl: string): KeyState {
  const value = (deps.secret(name) ?? '').trim();
  return { configured: Boolean(value), masked: mask(value), applyUrl };
}

/** 两个 key 的当前状态。 */
export function keyState(deps: SteamPanelDeps): ApiKeyState {
  return {
    steam: stateOf(deps, STEAM_SECRET_NAME, STEAM_APPLY_URL),
    itad: stateOf(deps, ITAD_SECRET_NAME, ITAD_APPLY_URL),
  };
}

/**
 * 把面板方法实现成一个纯函数,方便离线测。
 * 方法:status / save / clear(Steam)、save-itad / clear-itad(ITAD)。
 */
export function invokeSteamPanel(deps: SteamPanelDeps, method: string, args: unknown[]): ApiKeyState | { error: string } {
  const arg = typeof args[0] === 'string' ? args[0].trim() : '';

  if (method === 'status') return keyState(deps);

  if (method === 'save') {
    if (!arg) return { error: 'key 不能为空。要清掉请用 clear。' };
    // Steam Web API key 是 32 位十六进制
    if (!/^[0-9A-Fa-f]{32}$/.test(arg)) {
      return { error: '看起来不是 Steam Web API key(应为 32 位十六进制)。在 https://steamcommunity.com/dev/apikey 申请。' };
    }
    deps.storeSecret(STEAM_SECRET_NAME, arg);
    return keyState(deps);
  }

  if (method === 'clear') {
    if (!removeEnvLine(deps.envFile(), STEAM_SECRET_NAME)) {
      return { error: '没找到 .env,或者里面本来就没有 STEAM_API_KEY。' };
    }
    return keyState(deps);
  }

  if (method === 'save-itad') {
    if (!arg) return { error: 'key 不能为空。要清掉请用 clear-itad。' };
    // ITAD 的 key 是 32 位上下的字母数字串,长度和字符集先宽松校验,别卡死正常 key
    if (!/^[A-Za-z0-9]{16,64}$/.test(arg)) {
      return { error: '看起来不是 ITAD API key(应为 16–64 位字母数字)。在 https://isthereanydeal.com/apps/my/ 建一个应用就能拿到。' };
    }
    deps.storeSecret(ITAD_SECRET_NAME, arg);
    return keyState(deps);
  }

  if (method === 'clear-itad') {
    if (!removeEnvLine(deps.envFile(), ITAD_SECRET_NAME)) {
      return { error: '没找到 .env,或者里面本来就没有 ITAD_API_KEY。' };
    }
    return keyState(deps);
  }

  return { error: `没有这个方法:${method}` };
}

/** 配置组:只放非密钥项,密钥走面板。 */
export function steamConfigGroup(): ConfigGroup {
  return {
    id: 'world:steam',
    owner: 'world:steam',
    schema: {
      type: 'object',
      title: 'Steam',
      description: '本机 Steam 数据读取。两个 API key 在「Steam」页的输入框里填,不写进配置文件。',
      properties: {
        'worlds.steam.enabled': {
          type: 'boolean',
          title: '启用',
          description: '关掉后 World 不挂载,工具也用不了。',
          'x-hot': false,
        },
        'worlds.steam.steamPath': {
          type: 'string',
          title: 'Steam 安装目录',
          description: '留空自动从注册表探测。每次调用都现读,改完不用重启。',
          'x-path': { kind: 'directory' },
          'x-hot': true,
        },
        'worlds.steam.steamId': {
          type: 'string',
          title: 'SteamID64',
          description: '读哪个账号的 userdata。留空自动取当前登录的。',
          'x-hot': true,
        },
        'worlds.steam.reachOut': {
          type: 'boolean',
          title: '开/换游戏时主动递话',
          description: '关掉后只在被问到时才查。',
          'x-hot': true,
        },
        'worlds.steam.pollSeconds': {
          type: 'integer',
          title: '检测间隔',
          description: '多久查一次「有没有开新游戏」。越小越即时,3 秒已经够快。改完要重启 World。',
          minimum: 1,
          maximum: 30,
          'x-suffix': 's',
          'x-hot': false,
        },
        'worlds.steam.friendsEnabled': {
          type: 'boolean',
          title: '允许查好友在线',
          description: '默认关闭。打开后 steam_friends 才会读你的好友列表(需要 API key,且好友列表必须是公开的)。',
          'x-hot': true,
        },
        'worlds.steam.proxy': {
          type: 'string',
          title: '网络代理',
          description: 'auto=跟随系统代理(开着 Clash 就填这个),direct=直连,也可以填 http://127.0.0.1:7897。Steam 域名直连在国内会很慢。',
          'x-hot': true,
        },
        'worlds.steam.priceCountry': {
          type: 'string',
          title: '价格查询的地区',
          description: '两位国家码,默认 CN。现价和历史低价都按这个区算,不做任何汇率换算。',
          'x-hot': true,
        },
      },
    },
  };
}
