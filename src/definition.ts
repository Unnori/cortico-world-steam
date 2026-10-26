import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { STEAM_DEFAULTS, type SteamConfigSection } from './config.ts';
import { STEAM_TOOL_DECLS } from './tools.ts';
import { SteamWorld } from './world.ts';

export const STEAM: WorldDefinition<SteamConfigSection> = {
  id: 'steam',
  label: 'Steam',
  defaults: () => ({ ...STEAM_DEFAULTS }),
  create: (ctx) =>
    new SteamWorld(
      ctx.cfg,
      ctx.timezone,
      (name) => ctx.secret(name),
      (name, value) => ctx.storeSecret(name, value),
      ctx.botDir,
      ctx.dataDir,
    ),
  describe: {
    tools: describeTools(STEAM_TOOL_DECLS, {
      steam_now: {
        zh: '看现在在玩什么 Steam 游戏,以及累计时长。',
        en: 'Reports what Steam game is running right now.',
      },
      steam_profile: {
        zh: '看这台机器登录的 Steam 账号:昵称、SteamID64、在线状态、资料可见性。',
        en: 'Reports the signed-in Steam account: name, SteamID64, state and profile visibility.',
      },
      steam_playtime: {
        zh: '查某款或某些游戏的累计时长与最后游玩时间。',
        en: 'Reports playtime and last-played for one or more games.',
      },
      steam_library: {
        zh: '列 Steam 库:已安装、有游玩记录、或一次没玩过的。',
        en: 'Lists the Steam library by installed / played / untouched.',
      },
      steam_achievements: {
        zh: '看成就进度:总览,或某一款的解锁情况;可逐条列出还差哪几个 + 全服完成率。',
        en: 'Reports achievement progress overall or for one game, optionally naming what is still locked.',
      },
      steam_recent: {
        zh: '看最近两周玩了什么、各多久。',
        en: 'Reports what was played in the last two weeks.',
      },
      steam_friends: {
        zh: '看好友谁在线、在玩什么(默认关闭,需在配置里打开)。',
        en: 'Reports which friends are online and in game (off by default).',
      },
      steam_status: {
        zh: '看 Steam 接入状态:目录、账号、API key、好友开关、游戏数。',
        en: 'Reports the Steam integration state.',
      },
    }),
    events: [
      {
        type: 'steam.activity',
        description: {
          zh: '用户开游戏、换游戏或退出游戏了。',
          en: 'The person started, switched, or quit a Steam game.',
        },
        trigger: 'flush',
      },
    ],
  },
};
