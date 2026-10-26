/** 默认配置;`enabled` 由部署的 worlds.steam.enabled 决定。 */
export const STEAM_DEFAULTS = {
  enabled: false,
  /** Steam 安装目录;留空自动从注册表探测 */
  steamPath: '',
  /** 要读哪个账号的 userdata;留空自动取当前登录的 */
  steamId: '',
  /** Steam Web API key;留空只用本地数据(实际优先读 .env) */
  apiKey: '',
  timeoutMs: 12_000,
  /** 开局/换游戏时主动递话 */
  reachOut: true,
  /** 主动检测间隔(秒),1–30,默认 3 */
  pollSeconds: 3,
  /** 允许查好友在线;默认关闭(读好友列表属于隐私数据) */
  friendsEnabled: false,
  /** 价格查询的地区(ISO 3166-1 alpha-2);现价与史低都按这个区算 */
  priceCountry: 'CN',
  /** 网络代理:auto=跟随系统代理(Clash 等),direct=直连,也可直接填 http://127.0.0.1:7897 */
  proxy: 'auto',
} as const;

/** config.json 的 `worlds.steam` 节。 */
export interface SteamConfigSection {
  enabled: boolean;
  steamPath: string;
  steamId: string;
  apiKey: string;
  timeoutMs: number;
  reachOut?: boolean;
  pollSeconds?: number;
  friendsEnabled?: boolean;
  priceCountry?: string;
  proxy?: string;
}
