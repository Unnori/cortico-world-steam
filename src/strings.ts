import type { Language } from 'cortico/core/language.ts';

const zh = {
  moduleLabel: 'Steam',
  promptDocTitle: 'Steam · 环境提示词',
  promptDocDescription: '告诉 bot 什么时候该看 Steam;留空则不进入系统前缀。',
  apiKey: 'API key',
  apiKeySet: '已配置',
  apiKeyUnset: '未配置(未安装的游戏显示不出名字)',
  apiKeyUnsetBadge: '未配置',
  itadKey: 'ITAD',
  itadKeySet: '已配置',
  itadKeyUnset: '未配置(查不到历史最低价)',
  itadKeyUnsetBadge: '未配置',
  panelTitle: 'API key',
  panelDescription:
    '两个 key 都是选填,都落在部署的 .env 里,不写进 config.json。'
    + 'Steam key 补未安装游戏的名字、最近两周、成就、好友;ITAD key 查历史最低价(免费,登录后建个应用就有)。',
};

const en: typeof zh = {
  moduleLabel: 'Steam',
  promptDocTitle: 'Steam · Environment prompt',
  promptDocDescription: 'Tells the bot when to look at Steam; empty means it is not added to the system prefix.',
  apiKey: 'API key',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured (games that are not installed show no name)',
  apiKeyUnsetBadge: 'Not set',
  itadKey: 'ITAD',
  itadKeySet: 'Configured',
  itadKeyUnset: 'Not configured (no historical low)',
  itadKeyUnsetBadge: 'Not set',
  panelTitle: 'API keys',
  panelDescription:
    'Both keys are optional and live in the deployment .env, never in config.json. '
    + 'The Steam key fills in names for uninstalled games, the last two weeks, achievements and friends; '
    + 'the ITAD key adds historical low prices (free: sign in and register an app).',
};

export function text(language: Language): typeof zh {
  return language === 'zh' ? zh : en;
}
