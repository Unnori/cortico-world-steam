# cortico-world-steam

**让桌宠知道你 Steam 上在玩什么、玩多久、成就差哪几个,以及这款游戏现在值不值得买。**

给 Coopanion / Cortico 用的 World 扩展。只读本地记录,不写 Steam 任何文件。

[![npm](https://img.shields.io/npm/v/cortico-world-steam?color=2f6feb)](https://www.npmjs.com/package/cortico-world-steam)
[![license](https://img.shields.io/badge/license-MIT-2f6feb)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows-2f6feb)](#前置条件)

- **零配置可用** —— 昵称、在玩什么、每款时长、库、成就,全部读本机
- **价格不糊弄** —— 现价走 Steam 官方国区价,史低走 IsThereAnyDeal 的国区口径,不做美元换算
- **只读** —— 不写 Steam 文件、不启动游戏、不上传任何记录;联网只发生在可选的 API 上

<!-- 截图位:装好后从「高级模式 → World 总览 → Steam」截一张,替换这一行 -->

## 快速开始

1. 扩展页搜 `cortico-world-steam` → 安装 → 重启应用
2. 「World 总览」里找到 **Steam**,点**激活**(默认是关的,**这步别漏**)
3. 直接问:「我在玩什么」「星露谷的成就还差几个」「艾尔登法环现在史低多少」

> 想要未安装游戏的名字、成就明细、好友、史低,在「Steam API key」面板里填两个**可选**的 key。
> 都免费,不填也能用。见 [申请 key](#申请-key)。

## 它能做什么

| 你说 | 它做 |
|---|---|
| 我在玩什么 / 玩多久了 | `steam_now` · `steam_playtime` |
| 我最近在玩什么 | `steam_recent`(Steam 只有固定 14 天窗口) |
| 我库里有什么 / 有什么没玩过 | `steam_library` |
| 我的成就打得怎么样 / 还差哪几个 | `steam_achievements`(带全服完成率) |
| 这游戏多少钱 / 现在打折吗 / 史低多少 | `steam_price`(该区现价 + 该区史低) |
| 你知道我的 Steam 叫什么吗 | `steam_profile` |
| 谁在线 / XX 在玩什么 | `steam_friends`(默认关闭) |
| 这个能用吗 / 哪里出了问题 | `steam_status` |

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows | 读注册表、查进程、读 Steam 的本地文件,都只在 Windows 上成立 |
| Steam 客户端 | 装过、登录过。没开也能查历史(注册表和 `userdata` 都在),只是查不到「正在玩」 |
| Node 22+ | 跟着 Coopanion 带了,不用另装 |

## 安装

**从 npm 安装(普通用户)**

扩展页直接填包名 `cortico-world-steam`(可带 `@版本`)→ 安装 → 重启 → 激活。

**从目录安装(开发调试)**

1. 设置窗口 → 高级模式 →「扩展」→ 手动安装 → 填这个目录的**绝对路径**
2. 重启应用(扩展以 `link:` 方式装入,改了源码也要重启)
3. 高级模式 →「World 总览」→ 找到 **Steam** → **激活**

## 数据从哪来

| 来源 | 内容 | 要不要 key |
|---|---|---|
| 注册表 `HKCU\Software\Valve\Steam` | `RunningAppID`(正在玩)、`ActiveUser` | 不要 |
| `userdata/<id>/config/localconfig.vdf` | 每款游戏的 `Playtime`(分钟)、`LastPlayed` | 不要 |
| `steamapps/appmanifest_*.acf`(所有库) | 已安装游戏的名字、安装目录 | 不要 |
| `userdata/<id>/config/librarycache/achievement_progress.json` | 成就进度**索引**(不是每款都有) | 不要 |
| `userdata/<id>/config/librarycache/<appid>.json` | **单款成就明细**:`nAchieved`/`nTotal` + 每条名字、描述、解锁时间 | 不要 |
| `userdata/<id>/760/remote/<appid>/screenshots` | 截图数量与时间 | 不要 |
| `config/loginusers.vdf` | 本机登录过的账号:SteamID64、昵称 | 不要 |
| 进程表 + 主窗口 | 「现在是不是真在玩」的旁证 | 不要 |
| `ISteamUserStats/GetGlobalAchievementPercentagesForApp` | 成就的全服完成率(公开接口) | **不要** |
| Steam Web API `IPlayerService/GetOwnedGames` | **未安装游戏的名字** | **要** |
| Steam Web API `IPlayerService/GetRecentlyPlayedGames` | 最近两周玩了什么、各多久 | **要** |
| Steam Web API `ISteamUserStats/GetSchemaForGame` | 成就名称与描述 | **要** |
| Steam Web API `ISteamUserStats/GetPlayerAchievements` | 每一条成就你到底解锁了没 | **要** |
| Steam Web API `ISteamUser/GetPlayerSummaries` | 自己的档案、好友在线状态 | **要** |
| Steam Web API `ISteamUser/GetFriendList` | 好友列表(要求列表公开) | **要** |
| Steam Storefront `appdetails?cc=<地区>` | 该区现价与折扣(币种跟着地区) | 不要 |
| Steam Storefront `storesearch` | 库里没有的游戏,按名字找 appid | 不要 |
| **IsThereAnyDeal** `/games/prices/v3?country=<地区>` | **该区历史最低价** + 各商店当前最低 | **要**(免费) |

**为什么需要 key**:`localconfig.vdf` 里只存 appid,不存游戏名。已安装的能从 `appmanifest` 补,
但玩过、已经卸载的那些就只有数字。配了 key 才会显示成名字。

`GetOwnedGames` 那份结果在内存里缓存 **10 分钟**——工具调用频繁时不会每次都发请求。

> 部分接口还要求账号隐私设置里**「游戏详情」公开**(`GetOwnedGames` / `GetPlayerAchievements`),
> 好友还要**「好友列表」公开**。私密账号不会报错,只是拿回来是空的。

**两种账号 ID 别搞混**:`userdata` 目录名是**32 位账号 ID**(形如 `123456789`),Web API 要
**64 位 SteamID**(形如 `7656119xxxxxxxxxx`)。代码用 `toAccountId()` / `toSteamId64()` 双向换算:
读本地文件用前者,联网用后者。配置里填哪种都行。

`steam_status` 会顺手探一次 key(`GetPlayerSummaries`),把「已配置 / Steam 拒绝(401/403) /
查不到这个玩家」分开告诉你,不用靠猜。

### 申请 key

打开 <https://steamcommunity.com/dev/apikey>,填个域名(随便填,比如 `localhost`),免费拿到 32 位 key。

**填在哪**:控制台 → World 列表 → **Steam** 页 → 「Steam API key」面板,粘进去点保存。
值写进部署的 `.env`(`STEAM_API_KEY=...`),**不写进 config.json**,面板只回显掩码(`A1B2…8F90`)。

> 为什么不放 config.json:`config.json` 会被配置表单整体读写,也可能被备份/截图。
> 宿主的 `storeSecret()` 把密钥落到 `.env`,和模型 key 一个待遇。
>
> `clear` 会直接删掉 `.env` 里那一行——宿主的 `storeSecret` 不接受空值,所以清除只能自己动手。

## 九个工具

| 工具 | 用途 | 参数 | 要 key |
|---|---|---|---|
| `steam_profile` | 这台机器登录的号:昵称、SteamID64、在线状态、资料可见性 | — | 昵称不要,其余要 |
| `steam_now` | 现在在玩什么 + 可信度 | — | 不要 |
| `steam_playtime` | 某款/某几款的累计时长 | `query`、`top`、`since` | 不要 |
| `steam_recent` | 最近两周玩了什么、各多久 | `limit` | 时长要,列表不要 |
| `steam_library` | 库里有什么 | `filter`(installed/played/untouched/all)、`limit` | 不要 |
| `steam_achievements` | 成就进度;`show_missing` 逐条列还差哪几个 + 全服完成率 | `query`、`show_missing` | 名字/缺项要 |
| `steam_price` | 你所在区的现价、折扣、历史最低 | `query`、`refresh` | 现价不要,史低要 ITAD key |
| `steam_friends` | 好友谁在线、在玩什么 | `only_online`、`limit` | **要**,且默认关闭 |
| `steam_status` | 接入状态自检 | — | 不要 |

`query` 支持游戏名片段或 appid,多个用逗号分隔。
`since` 支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、`HH:mm`,以及 `7d` / `12h` / `2w` 这种相对写法(从现在往回数)。

### 账号:昵称不用 key 也能答

```
昵称:某个昵称
SteamID64:7656119xxxxxxxxxx
本机最近登录:2026-10-25 18:37
(昵称是本机 config/loginusers.vdf 里读的;在线状态、当前在玩、资料可见性、注册时间要 Steam Web API key)
```

配了 key 之后多出:当前状态(在线 / 游戏中:X)、资料可见性、真实名(若公开)、注册日期、
国家/地区、主页链接、上次下线时间。

**故意不读 `AccountName`**(`loginusers.vdf` 里那个登录名):它是登录凭据的一部分,比昵称敏感得多。
昵称 + SteamID64 已经够回答「你知道我的 Steam 叫什么吗」。

### 成就:真实缺项与稀有度

数据先读 `librarycache/<appid>.json`——那里有 `nAchieved`/`nTotal` 和每条成就的名字、描述、解锁时间;
索引 `achievement_progress.json` 只作兜底,因为**不是每款游戏都在索引里**
(实测就有游戏不在索引里,只读索引会报 0 个,实际是 25 条里拿了 12 个)。

`steam_achievements` 的 `show_missing` 不是「列出成就定义」,而是拿本地解锁状态
减去成就条目,**只列真没拿到的**,并按全服完成率从最稀有开始排:

```
某款游戏(1234560):11/27(41%)
  还差 14 个,从全服最稀有的开始:
    · 某个成就(全服 0.7%) — 成就描述……
    · 另一个成就(全服 0.9%) — 成就描述……
      …
```

隐藏成就不列(避免剧透);完成率来自公开接口,不需要 key,但解锁状态要。
数字对不上时先看「差几个」与本地缓存的总数:隐藏成就和没写 apiName 的条目会被跳过。

### 最近两周

Steam 只提供**固定 14 天**的窗口,不能自选天数。配了 key 才有「这两周各玩了多久」;
没配 key 会退回本地 `LastPlayed`,只能给「最后游玩日期」,并在回执里写明这一点。

### 价格与历史最低价

`steam_price` 回答三件事:你所在区现在多少钱、打几折、历史最低多少。

- **现价**:Steam Storefront `appdetails?cc=cn`,币种跟着地区走。**不做汇率换算**——
  美区史低折成人民币没有意义,国区定价本来就和美区脱钩。
- **史低**:IsThereAnyDeal `prices/v3?country=CN`,它按国家算低价,给你的就是国区史低
  (全时段 / 近一年 / 近三月),顺带给出各商店当前最低。
- **缓存**:`<dataDir>/steam-prices.json`。现价 1 小时、史低 24 小时,拉一次就存下来;
  `refresh: true` 强制刷新;超过 30 天的条目自动清掉。
- **库里没有的游戏**也能查:按名字走 `storesearch` 找 appid。
- **只给事实,不给结论**:回执里没有「建议购买」——那是模型结合上下文该说的话。
- 免费、区域不售卖、网络失败是三种不同的回执,不会混成一句「没数据」。

没配 ITAD key 时工具照常可用,只是史低那一段会明确说「查不到」并给出申请地址。

> 数据来源:**价格来自 Steam Store,史低来自 [IsThereAnyDeal](https://isthereanydeal.com/)**。
> ITAD 的条款要求署名,回执里也保留了这行。

### 好友在线(默认关闭)

`steam_friends` 在配置页 `worlds.steam.friendsEnabled` 打开前**直接拒绝**,不会偷偷读好友列表。
打开后还需要:API key、**好友列表公开**、而且**这把 key 要属于同一个账号**
(`GetFriendList` 对 key 与账号的一致性很挑,不满足就回 401)。

**已知限制**:好友列表是私密的账号一定会拿到 401,现在没有绕过的办法(Steam 没有别的公开接口)。
回执会直说「拿不到」,不会编人名。回执只包含昵称、在线状态、在玩什么。

## 交叉校验:三份证据

`steam_now` **不只看注册表**。Steam 的 `RunningAppID` 是客户端自己写的,退出游戏后**可能残留一阵**,
甚至能停在上一次的值;单看它会把「刚才玩过」当成「正在玩」。

所以每份结论背后有三份证据,全部来自本机,一次 PowerShell 调用同时取回:

1. **注册表**的 `RunningAppID`
2. **进程表**里那个游戏安装目录下的可执行文件在不在跑(覆盖 `libraryfolders.vdf` 里的所有库)
3. 这个进程有没有**可见的主窗口**(`MainWindowHandle ≠ 0`)

| verdict | 含义 | 依据 |
|---|---|---|
| `confirmed` ✅ | 确实在玩 | 三方都对上 |
| `likely` 🟡 | 大概在玩 | 注册表 + 进程,但没抓到主窗口 |
| `stale` ⚪ | 看着像在玩,其实退了 | 只有注册表有(残留值) |
| `outside` 🔵 | 有游戏在跑,不是 Steam 启动的 | 只有进程有 |
| `idle` ⚪ | 没在玩 | 都没有 |

回执里的 `verdict` 就是结论,**环境提示词要求模型照着它说话,不许自己升格**。

### 已知限制

- **全屏独占、窗口在子进程里、或者刚启动还在加载**时,可能拿不到主窗口 → 退化成 `likely`。
  这是保守的,不会误报成 `confirmed`。
- **启动器类的进程**(先起 launcher 再起游戏)可能只扫到 launcher;主窗口在游戏进程上时没问题,
  在 launcher 上时也能算 `confirmed`。
- **魔改版、独立启动器**导致进程路径不在 `steamapps/common` 下时,扫不到进程 → 退化成 `stale`。
- 进程扫描有 **5 秒缓存**,`stale` 只说明「这一刻没证据」,不代表游戏进程一定不在了。

一句话:**`confirmed` 可信,`likely` 是「有证据但不全」,`stale` 是「注册表说有但没旁证」。**

## 主动事件:开游戏就打招呼

每 `pollSeconds`(默认 **3 秒**)读一次 `RunningAppID`。**开游戏 / 换游戏 / 退出游戏**时推一条
`steam.activity` 事件,由模型自己决定接不接话。`reachOut: false` 可以关掉,工具照常能用。

两道防误报:

1. **进程必须真的在跑。** 注册表说「开了」不算数——退出后 `RunningAppID` 会残留,
   推事件前先确认该游戏的进程在进程表里。没有进程就当没发生,不推。
2. **启动时先记基线。** World 挂载那一刻正在玩的游戏不会被当成「刚开」,
   所以重启应用不会立刻蹦出一条「开游戏了」。

### 性能

| 操作 | 耗时 | 频率 |
|---|---|---|
| 读注册表(`reg query`) | ~100 ms | 每 `pollSeconds` 秒 |
| 扫进程 + 取主窗口(一次 PowerShell) | ~1.1 s | 只在 appid 变化时 + 5 秒缓存 |

> 用 `reg query` 而不是 PowerShell(76 ms vs 398 ms);用 `Get-CimInstance` 而不是
> `Get-Process | Where Path`(314 ms vs 3972 ms,差 12 倍);主窗口只对筛出来的那几个 pid 取。

## 配置

`config.json` 的 `worlds.steam`:

```json
{
  "enabled": true,
  "steamPath": "",
  "steamId": "",
  "apiKey": "",
  "timeoutMs": 12000,
  "reachOut": true,
  "pollSeconds": 3,
  "friendsEnabled": false,
  "priceCountry": "CN"
}
```

| 字段 | 说明 |
|---|---|
| `steamPath` | Steam 安装目录;留空从注册表探测,改完不用重启 |
| `steamId` | 读哪个账号的 `userdata`;留空取当前登录的 |
| `apiKey` | 兜底字段:密钥优先读 `.env` 的 `STEAM_API_KEY`,这里留空即可 |
| `reachOut` | 开局/换游戏时是否主动推事件 |
| `pollSeconds` | 主动检测间隔(1–30 秒),改完要重启 World |
| `friendsEnabled` | 是否允许查好友在线,**默认 `false`**;改完即时生效 |
| `priceCountry` | 价格查询的地区,两位国家码,默认 `CN`;现价和史低都按这个区算 |
| `proxy` | 网络代理:`auto`(默认,读系统代理)/ `direct` / `http://127.0.0.1:7897` |

### 申请 ITAD key(史低用)

打开 <https://isthereanydeal.com/apps/my/>(需要登录,Steam/邮箱都行)→ **Register App** →
App name 随便填(比如 `coopanion-steam`)→ 提交。页面上的 **API Keys** 就是 key,当场生成,不用等审批。

> 页面上还会生成 **OAuth 的 Client ID / Client Secret**,那两个**不要填**——插件用的是 API key,
> OAuth 走授权码 + 回跳地址,本地插件用不上。实测把 Client ID 或 Secret 当 key 用会 401/403。

免费额度和缓存完全够用(邮箱已验证的账号每 5 分钟 1000 次请求;这个插件现价 1 小时、史低 24 小时才拉一次)。
填在「Steam API key」面板的第二个输入框,存进 `.env` 的 `ITAD_API_KEY`。

### 面板与浏览器端产物

World 一旦在 `webUi()` 里声明 `panels`,框架就会去找 `cortico.webUiClient` 指向的浏览器端 bundle;
缺了它,面板位置会显示「缺少面板构建产物」。

面板里有两个 key 输入框(Steam / ITAD),各自带状态徽标、掩码、申请链接和一句申请说明。

本包**不打包**:`webUiClient` 直接指向手写的 `src/webui/client.js`(纯 ES module、零依赖,
只用宿主给的 `ctx.ui` 原语)。契约:

```js
export default { panels: { apikey: { mount(ctx) { /* ctx.ui / ctx.invoke */ } } } }
```

`panels` 的键必须和 `webUi().panels[].id` 一致。改完要重启进程再刷新页面;
版本号变了资源 URL 也会变,浏览器不会拿旧缓存。

## 环境提示词里的占位符

`src/ENV_PROMPT.md` 支持 `{{名字}}` 与 `{{名字 | 缺省文案}}`,值来自 `envPromptVars()`。
本包只用了两个:

| 占位符 | 内容 | 何时算 |
|---|---|---|
| `steam.now` | `现在在玩 X。` | 每轮,文本缓存 60 秒 |
| `steam.account` | `他的 Steam 昵称是「X」。` | 每轮,缓存 10 分钟 |

三条硬规则:

1. **模板里出现、但 `envPromptVars()` 没返回的占位符,会原样留在提示词里**——模型会看到 `{{steam.now}}` 这种字面量。
   所以模板和变量必须同步改(单测里有一条就是比对这两者)。
2. **值为空串时,`{{x}}` 会展开成空串**,容易留下「现在在玩。」这种残句。所以本包每个占位符都写了 `| 缺省文案`。
3. **变量名要带前缀**。所有 World 的变量会合到同一张表里,`now` / `count` 这种裸名会撞车。

什么时候该做占位符、什么时候不该:

- 该做:每轮对话都必须知道的**短状态**(他的昵称、现在在玩什么、亲密度、学过几条)。
- 不该做:被问了才需要的(价格、成就明细、最近两周)——`envPromptVars()` **每轮都会跑**,
  放重活等于给每条回复加延迟。这类用工具,按需查。

## 网络与代理

**Node 的 `fetch` 不读 Windows 系统代理。** 开着 Clash 的时候浏览器飞快,插件却在直连;
而 Steam 的域名直连国内又慢又容易挂住(表现为「等十几秒没响应」,不是 429)。
所以 `src/http.ts` 自己处理代理:

1. `proxy` 配置非 `auto`/`direct` → 直接用填的地址。
2. `auto` → 读系统代理:注册表 `ProxyEnable/ProxyServer`,读不到再换备用命令,最后看
   `HTTPS_PROXY/ALL_PROXY` 等环境变量。结果缓存 5 分钟。
3. 走代理靠 undici 的 `ProxyAgent`;undici 跟着宿主应用一起来,按绝对路径动态加载。
   加载不到就退回直连——此时 `steam_status` 会写「配了代理但走不通,实际直连」,不骗人。

`steam_status` 的网络那行就是最终生效的方式。实测同一台机器:开代理后 `steam_profile`
从 36 秒超时降到 1.2 秒。

## 隐私与边界

- **只读**:不写 Steam 的任何文件,不启动/关闭游戏,不读截图内容(只数数量和时间)。
- 读到的都是本机游戏记录,只在对话里用;环境提示词明确要求不要转述给第三方、不要写进对外内容。
- 联网只发生在:`api.steampowered.com`(配了 key 时补游戏名、最近两周、成就、好友),
  以及查成就完成率(公开接口)。不配 key 就完全离线。
- 好友数据默认不读:`friendsEnabled` 关着时 `steam_friends` 直接拒绝,环境提示词也不许主动提。
- 账号档案里的 `AccountName`(登录名)**不读、不进对话**;SteamID64、真实名、注册时间属于账号身份,
  环境提示词要求只在私下说、不主动念。
- 本地数据每次调用现读,不落盘;内存里只留 5 秒的进程扫描缓存和 10 分钟的拥有游戏缓存。

## 开发

```bash
cd <包目录>
corepack pnpm install
pnpm typecheck && pnpm test
```

在 Cortico 仓库根(`vendor/cortico`)下做发布前检查:

```bash
corepack pnpm install
corepack pnpm describe:extension <包目录>   # 代码里的声明 → describe.json,并补进 package.json
corepack pnpm check:extension    <包目录>   # manifest / 导出结构 / 构造 / 工具名冲突 / describe 一致性
```

`check:extension` 不调 `start()`,也不验证真实服务;它只保证「装得上、声明对得上」。

## 打包与发布

```bash
npm pack                     # 产出 cortico-world-steam-1.0.0.tgz
tar -tzf cortico-world-steam-0.7.2.tgz    # 验一遍内容清单,files 写漏了装到用户机器上就是缺文件
npm publish --access public
```

`keywords` 必须带 `cortico-world`——扩展页的市场搜索就是按 `keywords:cortico-world` 查的。

上架市场要再往索引仓提一个 issue(标签、认证、收录都以那边为准):

```bash
gh issue create --repo Pal-AI-Lab/cortico-extensions \
  --title "[tags] cortico-world-steam" --body-file request.txt
```

私有分发不必上 npm:`.tgz` 直接给用户,让他在扩展页填绝对路径;或者把解压后的目录填进去做 link。

## 目录

```
src/
├── index.ts          默认导出 WorldDefinition
├── definition.ts     id / label / defaults / create / describe
├── config.ts         配置段类型 + 默认值
├── settings.ts       配置组 JSON Schema + API key 面板方法(纯函数,可离线测)
├── world.ts          轮询、推事件、webUi 声明
├── tools.ts          九个工具的实现
├── cross-check.ts    三方对账(注册表 / 进程 / 主窗口)
├── steam-local.ts    注册表、localconfig.vdf、appmanifest、成就、截图的读取
├── steam-api.ts      Steam Web API 薄封装(只在配了 key 时用)
├── price.ts          现价 / 史低 / 价格缓存(Steam Storefront + ITAD)
├── http.ts           统一的网络出口(系统代理 / 直连)
├── time.ts           按配置时区解析/显示时间
├── strings.ts        面板与页面文案(zh/en)
├── ENV_PROMPT.md     环境提示词模板
├── icon.svg          扩展卡片图标
└── webui/client.js   手写的浏览器端面板
```
