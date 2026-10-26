/**
 * Steam 页的面板:填 / 改 / 清两个 API key(Steam Web API key、IsThereAnyDeal API key)。
 *
 * 这个文件是**手写的浏览器端 bundle**,没有构建步骤:
 * `package.json` 的 `cortico.webUiClient` 直接指向它。它不 import 任何东西,
 * 只用宿主传进来的 `ctx.ui` 原语,所以不需要打包器。
 *
 * 契约:`export default { panels: { <panelId>: { mount(ctx) } } }`
 * —— panelId 必须和 World `webUi().panels` 里声明的 id 一致。
 *
 * 密钥只在这些输入框里出现,保存后服务端只回掩码。
 */

const TEXT = {
  zh: {
    title: 'API key',
    desc: '两个都选填。值存在部署的 .env 里,不写进 config.json。没配也能用,只是能力少一块。',
    configured: '已配置',
    notConfigured: '未配置',
    save: '保存',
    clear: '清除',
    saved: '已保存。',
    cleared: '已清除。',
    empty: '先粘贴一个 key。',
    cards: [
      {
        id: 'steam',
        title: 'Steam Web API key',
        desc: '补全未安装游戏的名字、最近两周时长、成就详情与好友在线。没配时,未安装的游戏只显示 appid,成就只有数字没有名字。',
        fieldLabel: 'key(32 位十六进制)',
        placeholder: '粘贴 32 位 key…',
        apply: '去申请(免费,登录 Steam 即可)',
        note: '申请只要一步:打开页面,填个域名(随便填 localhost),立刻给你 key。',
      },
      {
        id: 'itad',
        title: 'IsThereAnyDeal API key',
        desc: '查游戏在你所在区的历史最低价(含近一年/近三月),不做美元换算。没配时价格工具只报 Steam 现价。填的是 API key,不是 OAuth 的 Client ID / Client Secret。',
        fieldLabel: 'key(字母数字)',
        placeholder: '粘贴 ITAD key…',
        apply: '去申请(免费,登录后建个应用)',
        note: '打开页面 → 点 Register App → App name 随便填 → 提交,页面上 API Keys 那一块就是 key(旁边还有 OAuth 的 Client ID/Secret,那两块不是给这里用的)。',
      },
    ],
  },
  en: {
    title: 'API keys',
    desc: 'Both are optional. They are stored in the deployment .env, never in config.json. Without them the World still works, with less detail.',
    configured: 'Configured',
    notConfigured: 'Not set',
    save: 'Save',
    clear: 'Clear',
    saved: 'Saved.',
    cleared: 'Cleared.',
    empty: 'Paste a key first.',
    cards: [
      {
        id: 'steam',
        title: 'Steam Web API key',
        desc: 'Fills in names for uninstalled games, the last two weeks, achievement details and friends online. Without it, uninstalled games show only an appid and achievements have no names.',
        fieldLabel: 'key (32 hex characters)',
        placeholder: 'Paste the 32-character key…',
        apply: 'Apply (free, just sign in)',
        note: 'One step: open the page, enter any domain (localhost works), and the key is issued immediately.',
      },
      {
        id: 'itad',
        title: 'IsThereAnyDeal API key',
        desc: 'Adds the historical low price for your own region (all time, past year, past 3 months), with no USD conversion. Without it the price tool reports the Steam price only. Paste the API key, not the OAuth Client ID / Secret.',
        fieldLabel: 'key (letters and digits)',
        placeholder: 'Paste the ITAD key…',
        apply: 'Apply (free, register an app)',
        note: 'Open the page, click Register App, enter any app name, submit — the key is under API Keys.',
      },
    ],
  },
};

function textFor(language) {
  return typeof language === 'string' && language.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
}

/** 服务端也会用 {error} 正常返回,统一收成一句话。 */
function errorOf(value) {
  if (value && typeof value === 'object' && typeof value.error === 'string' && value.error) return value.error;
  return '';
}

/** 一个 key 的输入块:状态徽标 + 申请链接 + 输入框 + 保存/清除。 */
function keyCard(ctx, t, card) {
  const { ui } = ctx;
  const section = ui.sheet({ title: card.title, desc: card.desc });
  section.el.classList.add('steam-key-card');

  const statusRow = ui.rowbar();
  const applyLink = ui.h('a', null, card.apply);
  applyLink.target = '_blank';
  applyLink.rel = 'noreferrer';
  statusRow.append(applyLink);

  const input = ui.input({ type: 'password', placeholder: card.placeholder, cls: 'mono' });
  const saveBtn = ui.button(t.save, { variant: 'primary', size: 'sm', onClick: () => void save() });
  const clearBtn = ui.button(t.clear, { variant: 'danger', size: 'sm', onClick: () => void clear() });
  const actions = ui.rowbar();
  actions.append(saveBtn, clearBtn);

  const msg = ui.msgline();
  const hint = ui.h('p', null, card.note);

  section.body.append(statusRow, ui.field(card.fieldLabel, input), actions, msg, hint);
  ctx.root.append(section.el);

  let busy = false;

  function say(text, bad) {
    msg.textContent = text ?? '';
    msg.classList.toggle('bad', Boolean(bad));
  }

  function render(state) {
    const configured = Boolean(state && state.configured);
    const pill = ui.pill(configured ? `${t.configured} ${state.masked}` : t.notConfigured, configured ? 'on' : 'off');
    statusRow.replaceChildren(pill, applyLink);
    if (state && state.applyUrl) applyLink.href = state.applyUrl;
  }

  async function save() {
    if (busy) return;
    const value = input.value.trim();
    if (!value) {
      say(t.empty, true);
      input.focus();
      return;
    }
    busy = true;
    const off = ui.disable(saveBtn);
    try {
      const out = await ctx.invoke(card.id === 'steam' ? 'save' : 'save-itad', [value]);
      const bad = errorOf(out);
      if (bad) {
        say(bad, true);
      } else {
        input.value = '';
        render(out[card.id]);
        say(t.saved, false);
        void ctx.refresh();
      }
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      off.dispose();
      busy = false;
    }
  }

  async function clear() {
    if (busy) return;
    busy = true;
    const off = ui.disable(clearBtn);
    try {
      const out = await ctx.invoke(card.id === 'steam' ? 'clear' : 'clear-itad');
      const bad = errorOf(out);
      if (bad) {
        say(bad, true);
      } else {
        render(out[card.id]);
        say(t.cleared, false);
        void ctx.refresh();
      }
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      off.dispose();
      busy = false;
    }
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void save();
    }
  });

  return { render };
}

const apikeyPanel = {
  mount(ctx) {
    const t = textFor(ctx.language);
    const cards = t.cards.map((card) => ({ id: card.id, ...keyCard(ctx, t, card) }));

    async function refresh() {
      try {
        const state = await ctx.invoke('status');
        const bad = errorOf(state);
        if (bad) return;
        for (const card of cards) card.render(state[card.id]);
      } catch {
        // 状态拉不到就先空着,保存时会给具体错误
      }
    }

    void refresh();
  },
};

export default { panels: { apikey: apikeyPanel } };
