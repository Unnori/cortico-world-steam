/**
 * Steam World:读本机 Steam 状态,让 bot 知道使用者在玩什么、玩了多少。
 *
 * 每 pollSeconds 秒看一次注册表的 RunningAppID;开了 reachOut 就推一条事件,
 * 由模型自己决定接不接话——不替模型决定说什么。
 */
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { SteamConfigSection } from './config.ts';
import { STEAM_PANEL_ID, ITAD_SECRET_NAME, STEAM_SECRET_NAME, invokeSteamPanel, steamConfigGroup } from './settings.ts';
import { crossCheck, hasProcessFor } from './cross-check.ts';
import { detectSteamId, detectSteamPath, readInstalled, readLoginUsers, readRegistry, toAccountId, toSteamId64, type SteamConfig } from './steam-local.ts';
import { text } from './strings.ts';
import { steamTools } from './tools.ts';
import { fmtDateTime } from './time.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class SteamWorld implements World {
  readonly id = 'steam';

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickoff: ReturnType<typeof setTimeout> | null = null;
  /** 上次看到的 appid;'' 表示没在玩 */
  private lastAppId = '';
  private lastCheckAt = 0;
  /** 上一轮 tick 还没跑完 */
  private ticking = false;

  constructor(
    private readonly cfg: SteamConfigSection,
    private readonly timezone: string,
    private readonly secret: (name: string) => string = () => '',
    private readonly storeSecret: (name: string, value: string) => void = () => {},
    /** 部署目录,用来定位 .env(清除密钥时直接改它) */
    private readonly botDir: string = '',
    /** 数据目录(所有 World 共用),价格缓存落在这里 */
    private readonly dataDir: string = '',
  ) {}

  /** 有效 apiKey:密钥优先,配置里的当兜底(方便老配置直接写)。 */
  private apiKey(): string {
    const fromSecret = (this.secret(STEAM_SECRET_NAME) ?? '').trim();
    if (fromSecret) return fromSecret;
    return (this.cfg.apiKey ?? '').trim();
  }

  /**
   * 环境提示词里两个占位符的值。
   *
   * 只在拼系统前缀时调用(每轮都会跑),所以**只放便宜、且每轮都该在上下文里的状态**:
   *  - steam.now     现在在玩什么(读注册表 + appmanifest,60 秒缓存)
   *  - steam.account 他的 Steam 昵称(读 loginusers.vdf,10 分钟缓存)
   * 价格、成就、最近两周这类"被问了才需要"的,一律留给工具,不在这里算。
   */
  envPromptVars(): Record<string, string> {
    return {
      'steam.now': this.promptNow(),
      'steam.account': this.promptAccount(),
    };
  }

  /** 本地配置:给 detect* 系列用的最小形状。 */
  private localCfg(): SteamConfig {
    return {
      steamPath: (this.cfg.steamPath ?? '').trim(),
      steamId: (this.cfg.steamId ?? '').trim(),
      apiKey: '',
      timeoutMs: Number(this.cfg.timeoutMs) > 0 ? Number(this.cfg.timeoutMs) : 12000,
    };
  }

  /** 路径与账号 ID 的解析结果:探测一次要扫 userdata,缓存 10 分钟。 */
  private identityCache: { at: number; steamPath: string; accountId: string } | null = null;

  private identity(): { steamPath: string; accountId: string } {
    if (this.identityCache && Date.now() - this.identityCache.at < 10 * 60_000) {
      return this.identityCache;
    }
    let steamPath = '';
    let accountId = '';
    try {
      const local = this.localCfg();
      steamPath = detectSteamPath(local);
      accountId = toAccountId(detectSteamId(local, steamPath));
    } catch {
      // 读不到就当没有
    }
    this.identityCache = { at: Date.now(), steamPath, accountId };
    return this.identityCache;
  }

  private promptNowCache: { at: number; text: string } | null = null;

  private promptNow(): string {
    if (this.promptNowCache && Date.now() - this.promptNowCache.at < 60_000) return this.promptNowCache.text;
    let text = '';
    try {
      const { steamPath } = this.identity();
      if (steamPath) {
        // 和 steam_now 用同一套判据:注册表残留 + 进程 + 主窗口
        const registryAppId = readRegistry().appid;
        const check = crossCheck({
          steamPath,
          registryAppId: registryAppId === '0' ? '' : registryAppId,
        });
        if (check.verdict !== 'idle' && check.verdict !== 'stale') {
          const appid = check.registryAppId || check.processes[0]?.appid || '';
          const name = appid ? readInstalled(steamPath).get(appid)?.name ?? '' : '';
          if (name) text = `现在在玩 ${name}。`;
        }
      }
    } catch {
      // 读不到就当没在玩,不让前缀组装失败
    }
    this.promptNowCache = { at: Date.now(), text };
    return text;
  }

  private promptAccountCache: { at: number; text: string } | null = null;

  private promptAccount(): string {
    if (this.promptAccountCache && Date.now() - this.promptAccountCache.at < 10 * 60_000) {
      return this.promptAccountCache.text;
    }
    let text = '';
    try {
      const { steamPath, accountId } = this.identity();
      if (steamPath && accountId) {
        const steamId64 = toSteamId64(accountId);
        const mine = readLoginUsers(steamPath).find((user) => user.steamId64 === steamId64);
        if (mine?.personaName) text = `他的 Steam 昵称是「${mine.personaName}」。`;
      }
    } catch {
      // 同上
    }
    this.promptAccountCache = { at: Date.now(), text };
    return text;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    if (this.timer) return;
    // 开局先记下当前状态,别一挂载就报「他开游戏了」
    this.lastAppId = this.currentAppId();
    // 主动检测要快:注册表读一次 76ms,3 秒一轮不算负担
    this.timer = setInterval(() => this.tick(), this.pollMs());
    this.kickoff = setTimeout(() => {
      this.kickoff = null;
      this.tick();
    }, 3000);
  }

  private pollMs(): number {
    const raw = Number(this.cfg.pollSeconds);
    const seconds = Number.isFinite(raw) && raw >= 1 ? Math.min(30, Math.trunc(raw)) : 3;
    return seconds * 1000;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.kickoff) clearTimeout(this.kickoff);
    this.timer = null;
    this.kickoff = null;
    this.host = null;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const hasKey = Boolean(this.apiKey());
    const hasItad = Boolean(this.itadKey());
    return {
      label: t.moduleLabel,
      // 两条链路:Steam key / ITAD key
      lamps: [
        hasKey
          ? { label: t.apiKey, state: 'online' as const, hint: t.apiKeySet }
          : { label: t.apiKey, state: 'offline' as const, hint: t.apiKeyUnset },
        hasItad
          ? { label: t.itadKey, state: 'online' as const, hint: t.itadKeySet }
          : { label: t.itadKey, state: 'offline' as const, hint: t.itadKeyUnset },
      ],
      badges: [
        hasKey
          ? { label: t.apiKey, value: t.apiKeySet, tone: 'on' as const }
          : { label: t.apiKey, value: t.apiKeyUnsetBadge, tone: 'off' as const },
        hasItad
          ? { label: t.itadKey, value: t.itadKeySet, tone: 'on' as const }
          : { label: t.itadKey, value: t.itadKeyUnsetBadge, tone: 'off' as const },
      ],
      panels: [
        {
          id: STEAM_PANEL_ID,
          title: t.panelTitle,
          description: t.panelDescription,
          // status 允许 GET,其余走 POST
          getMethods: ['status'],
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== STEAM_PANEL_ID) throw new Error(`没有这个面板:${panel}`);
        return invokeSteamPanel(
          {
            secret: this.secret,
            storeSecret: this.storeSecret,
            envFile: () => (this.botDir ? `${this.botDir}/.env` : ''),
          },
          method,
          args,
        );
      },
      config: [steamConfigGroup()],
      promptDocs: [
        {
          key: 'worlds.steam.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  tools(): ToolDef[] {
    return steamTools({
      cfg: () => ({ ...this.cfg, apiKey: this.apiKey() }),
      timezone: this.timezone,
      // ITAD key 也走宿主的 secret(),和 Steam key 一样落在 .env
      itadKey: () => this.itadKey(),
      dataDir: this.dataDir,
    });
  }

  /** 有效 ITAD key:只从 .env 读(价格工具用)。 */
  private itadKey(): string {
    return (this.secret(ITAD_SECRET_NAME) ?? '').trim();
  }

  private currentAppId(): string {
    try {
      const state = readRegistry();
      return state.appid && state.appid !== '0' ? state.appid : '';
    } catch {
      return '';
    }
  }

  /** 看有没有换游戏;换了就推一条事件。 */
  private tick(): void {
    const host = this.host;
    if (!host) return;
    if (this.cfg.reachOut === false) return;
    // 上一轮还在跑就跳过,别叠
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = Date.now();
      this.lastCheckAt = now;
      const appid = this.currentAppId();
      if (appid === this.lastAppId) return;

      const previous = this.lastAppId;
      this.lastAppId = appid;

      // 注册表说「开了」不算数,得看进程在不在——退出后 RunningAppID 会残留
      if (appid && !this.isRunning(appid)) return;

      const steamPath = detectSteamPath({
        steamPath: (this.cfg.steamPath ?? '').trim(),
        steamId: '',
        apiKey: '',
        timeoutMs: 8000,
      });
      const installed = steamPath ? readInstalled(steamPath) : new Map<string, { name: string; dir: string }>();
      const nameOf = (id: string): string => {
        const name = installed.get(id)?.name;
        return name ? `${name}(appid ${id})` : `appid ${id}`;
      };

      const body = (() => {
        if (!appid) {
          return `[Steam] 退出了 Steam 游戏${previous ? `(${nameOf(previous)})` : ''}。`;
        }
        const prefix = previous ? '换了游戏' : '开游戏了';
        return [
          `[Steam] ${prefix}:${nameOf(appid)}。`,
          `时间 ${fmtDateTime(now, this.timezone)}`,
          '这是他本机 Steam 的实际状态,进程也确认在跑。要不要搭话、说什么,按你自己的性子来;不想说就放着。',
        ].join('\n');
      })();

      host.pushDeferred?.(
        { type: 'steam.activity', origin: 'internal', render: () => body },
        { trigger: 'flush' },
      );
    } catch {
      // 读注册表失败就跳过这一轮
    } finally {
      this.ticking = false;
    }
  }

  /** 这个 appid 的游戏进程现在是否真的在跑。 */
  private isRunning(appid: string): boolean {
    const steamPath = detectSteamPath({
      steamPath: (this.cfg.steamPath ?? '').trim(),
      steamId: '',
      apiKey: '',
      timeoutMs: 8000,
    });
    if (!steamPath) return false;
    // 走交叉校验模块的进程扫描(带 20 秒缓存,不会每 3 秒扫一次全表)
    return hasProcessFor(steamPath, appid);
  }
}
