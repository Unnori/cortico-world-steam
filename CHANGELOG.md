# 更新日志

## 1.0.0

首个公开发布版本。功能与 0.7.3 一致,细节看下面几节。一句话概括:

- **9 个工具**:`steam_now` / `steam_profile` / `steam_playtime` / `steam_library` /
  `steam_achievements` / `steam_recent` / `steam_price` / `steam_friends` / `steam_status`
- 全部数据来自**本机 Steam 客户端**,不写任何文件;联网只发生在可选的 API(补游戏名、成就、价格、好友)
- 两个 key 都选填:Steam Web API key 补游戏名/成就/好友,ITAD key 查该区历史低价
- 环境提示词带 `{{steam.now}}` / `{{steam.account}}` 两个占位符,每轮自动刷新
- 国内直连 Steam 会很慢:内置系统代理探测(Clash 之类),`proxy` 默认 `auto`

## 0.7.3

- **环境提示词开始用占位符**,只放两条「每轮都该在上下文里、而且算起来便宜」的:
  - `{{steam.now}}` → `现在在玩 X。`(注册表 + 进程 + 主窗口,和 `steam_now` 同一套判据)
  - `{{steam.account}}` → `他的 Steam 昵称是「X」。`(读 `loginusers.vdf`)
  两个都带 `| 缺省文案`,取不到值时不会留下残句。
- **成本控制**:占位符是在**每次拼系统前缀**时算的,所以:
  - `steam.now` 文本缓存 60 秒,进程扫描本身有 5 秒缓存(World 每 3 秒轮询,通常直接命中,**0ms**);
  - `steam.account` 缓存 10 分钟,路径/账号解析也缓存 10 分钟;
  - 冷启动第一次约 1.2 秒(一次性进程扫描),之后是 0ms。
- **刻意不做的**:价格、成就、最近两周没有做成占位符。它们要么要联网、要么每次都要读几百个文件,
  而且只在被问到时才有意义——这类一律留给工具,不拖慢每一轮。
- 发布前清理:README / CHANGELOG 里的个人账号示例(账号 ID、SteamID、昵称、具体游戏)换成通用值。

## 0.7.2

真机上又抓到两个问题:一个读错数据,一个把网络问题误判成限流。

- **修成就读数(重要)。** 之前只读 `achievement_progress.json` 里的索引,而**不是每款游戏都在索引里**;
  某款游戏就不在索引里,于是报了 0 个成就。现在优先读
  `userdata/<账号>/config/librarycache/<appid>.json`——那里有 `nAchieved`/`nTotal` 和逐条的名字、
  描述、解锁时间。同一款游戏从「0 个」变成 **12/25**。索引只作为兜底。
- **成就缺项不再必须配 key。** 本地那份带每条名字,`show_missing` 直接就能列出还差哪几个;
  配了 key 再叠全服完成率。`steam_now` 里的成就数也改用这份精确数据。
- **中文名能查到了。** 本地游戏名是 `appmanifest` 里的英文名,以前问中文名会回
  「库里没有」。现在 `steam_achievements` 和 `steam_playtime` 在本地匹配不到时,会去 Steam 商店搜一次
  (带 1 秒节流与冷却),命中后照常用本地数据。实测:中文名问「某款游戏」能落到对应 appid,
  并带出真实的时长与成就进度。
- **新增网络代理支持。** Node 的 `fetch` **不读 Windows 系统代理**,所以开着 Clash 时浏览器很快、
  插件却在直连——Steam 的域名直连国内又慢又爱挂住,之前被我误判成「Steam 限流」。
  现在 `proxy` 默认 `auto`:读系统代理(注册表,读不到再换备用命令,最后看环境变量),
  用 undici 的 ProxyAgent 走它;拿不到 undici 就退回直连,并在状态里**说实话**。
  - 实测:同一条命令,`steam_profile` 从 36 秒超时 → 1.2 秒;`steam_status` 从 38 秒 → 4.4 秒。
  - 新增配置 `worlds.steam.proxy`:`auto` / `direct` / 具体地址(如 `http://127.0.0.1:7897`)。
  - `steam_status` 多一行「网络:代理 http://127.0.0.1:7897」,配了代理但走不通时会明说。

## 0.7.1

真机测试（把包 link 进运行中的实例、用真实密钥跑到全部 9 个工具）之后修的三处：

- **价格缓存按「appid + 地区」分开。** 之前缓存键只有 appid，把 `priceCountry` 从 CN 改成 US 之后，
  会拿着国区缓存当美区报（`Steam US 现价:¥48.00`）。现在两个地区各存各的，互不串。
- **免费游戏不再显示成「ITAD 记录的是 ¥0.00」。** ITAD 的 deals 里 Steam 那条是 0 元就判免费，
  并且不再给免费游戏报史低（它可能以前是付费的，那个数字只会误导）。
- **`steam_playtime` 带 `since` 时，合计口径写成「筛出的 N 款合计」。** 之前写「全部累计」，
  实际算的是筛完那一批，容易被读成库里全部。

## 0.7.0

- **新增 `steam_price`**:某款游戏在**你所在区**卖多少钱、打几折、历史最低多少。
  - 现价走 Steam Storefront `appdetails?cc=<地区>`,**币种跟着地区走**,不做任何汇率换算。
  - 史低走 IsThereAnyDeal `/games/prices/v3?country=<地区>`——ITAD 按国家算低价,
    拿到的就是国区史低(全时段 + 近一年 + 近三月),顺手给各商店当前最低。
  - 库里没有的游戏也能查:先按名字在 Steam 商店搜 appid。
  - 结果缓存在 `<dataDir>/steam-prices.json`(现价 1 小时、史低 24 小时),**拉一次就不再重复拉**;
    `refresh: true` 可以强制刷新。缓存文件 30 天后自动清条目。
  - 免费游戏 / 区域不售卖 / 网络失败是三种不同的回执,不混成一句「没数据」。
  - 插件只给事实,不写「建议购买」。
- **面板改成两个 key**:Steam Web API key + IsThereAnyDeal API key,各自带状态徽标、掩码、
  申请链接和一句「怎么申请」。两个都在 `.env`(`STEAM_API_KEY` / `ITAD_API_KEY`),
  World 页多一盏 ITAD 状态灯。
- 新增配置项 `worlds.steam.priceCountry`(默认 `CN`),现价与史低都按这个区算。
- 没配 ITAD key 时价格工具照常可用,只是没有史低,并会直接说明去哪申请。
- **商店请求加了节流**:Steam 对连续请求不是回 429,而是**直接挂住不响应**。现在两次商店请求至少隔 1 秒,
  单次超时 8 秒且不重试(重试只会让人干等)。实测连发 5 次后被限流,加了闸之后恢复。
- **「没搜到」和「商店没响应」分开了**:之前两者都报「也没搜到」,现在是
  「商店这会儿没响应(可能被限流),过一会儿再试,或者直接告诉我 appid」。
- **实时价拉不到时用 ITAD 兜底**:ITAD 的 deals 里有 Steam 自己的记录,拿它顶上并注明不是实时价。
- 「别处更便宜」只在**真的比 Steam 便宜**时才出现;同价(比如 GOG 也是 ¥48)不再占一行。
- 面板的 ITAD 输入框写明:填 API key,**不是** OAuth 的 Client ID / Client Secret(实测那两个当 key 用会 403)。
- 纯数字的查询直接当 appid 用,不再为了认 id 去问商店(商店挂掉时也能查)。
- 库和商店都拿不到标题时,用 ITAD lookup 返回的标题兜底,回执不会只剩「appid 1091500」。

## 0.6.0

- **新增 `steam_profile`**:这台机器登录的 Steam 账号是谁。昵称、SteamID64、在线状态、当前在玩、
  资料可见性、注册日期、主页链接。
  - **没配 key 也能答昵称**:直接读 `<Steam>/config/loginusers.vdf`(里面有 SteamID64 与 PersonaName),
    顺带给出本机最近登录时间。实测 10ms。
  - 配了 key 就用 `GetPlayerSummaries` 补在线状态、当前在玩、资料公开性与注册时间;
    失败时会区分「key 被拒」「查不到这个玩家」「网络问题」。
  - **故意不读 `AccountName`**:那是登录用的账号名,比昵称敏感,不进对话也不进日志。
- 环境提示词加了一节「说他的账号」:昵称可以直接答,但 SteamID64、真实名、注册时间、主页
  属于账号身份,**只在私下说,不主动念**。
- 好友摘要的类型顺手扩成通用的 `PlayerSummary`(多了真实名、可见性、注册时间、国家码、主页),
  `steam_friends` 的输出不变。

## 0.5.0

三个新功能,外加一个一直藏着的大 bug。

- **修 SteamID 形态不匹配(配了 key 也不生效的根因)。** `userdata` 目录名是 **32 位账号 ID**
  (形如 `123456789`),而 Web API 要 **64 位 SteamID**(形如 `7656119xxxxxxxxxx`)。
  旧代码把同一个值两边都用,于是 `GetOwnedGames` / `GetRecentPlayedGames` 全部 400/401,
  名字一直补不上。现在 `toAccountId()` / `toSteamId64()` 双向换算:本地文件用账号 ID,联网用 64 位。
  实测同一把 key、同一台机器,「只有 appid 的游戏」从 169 款降到 45 款。
- **key 是否可用现在会被验证。** `steam_status` 会探一次(`GetPlayerSummaries`),把
  「已配置」「Steam 拒绝(401/403)」「查不到这个玩家」分开说;成就查询失败时也先区分
  「key 被拒」和「游戏没数据」,不再把 403 说成「没有成就定义」。
- **网络抖动重试一次**:超时/连接失败时 400ms 后重试,HTTP 4xx 不重试(那是权限或参数问题)。
- **`show_missing` 现在是真的缺项。** 以前是把成就定义的前 10 条列出来,不管你拿没拿;
  现在拿 `GetPlayerAchievements` 的解锁状态减去 `GetSchemaForGame` 的定义,**只列没拿到的**,
  并叠上 `GetGlobalAchievementPercentagesForApp` 的全服完成率,从最稀有的开始排。
  隐藏成就不列(避免剧透);本地没有成就缓存时也能查(只要有 key)。
- **新增 `steam_recent`**:最近两周玩了什么、各多久。Steam 只有固定 14 天窗口。
  有 key 走 `GetRecentlyPlayedGames` 拿两周时长;没 key 退回本地 `LastPlayed`,并在回执里写明差别。
- **新增 `steam_friends`**:好友谁在线、在玩什么。`GetFriendList` + 批量 `GetPlayerSummaries`
  (每 100 个一批)。**默认关闭**,配置项 `worlds.steam.friendsEnabled`,关着时工具直接拒绝并说明去哪开;
  还要求 API key 与公开的好友列表。环境提示词明确要求不主动提好友。
- **修 `since` 的相对写法**:`7d` / `12h` / `2w` 之前会被静默忽略(等于没过滤),现在真的生效;
  `7m` 这种月和分钟会打架的写法仍然拒绝。参数说明同步。
- `GetOwnedGames` 的结果加了 10 分钟内存缓存:工具调用频繁时不再每次都发请求。
- `steam_status` 多一行「好友查询:开/关」;工具数从 5 变 7,`describe.json` 重生成。

## 0.4.0

从个人实例里单独抽出来,做成可以直接发布的一个包;同时把外部依赖全部去掉。

- **去掉 ActivityWatch 依赖。** 交叉校验原来靠 ActivityWatch 最近 N 分钟的窗口事件当第三方证据,
  现在换成本机进程的主窗口句柄:一次 PowerShell 调用同时读注册表、枚举 `steamapps` 下的进程、
  为这几个进程取 `MainWindowHandle`。不再需要装任何后台程序,也不再往 `127.0.0.1:5600` 发请求。
- **修多库漏扫。** 原来只扫 `<Steam>/steamapps`,游戏装在 `libraryfolders.vdf` 里的其他库时,
  进程和 appmanifest 都匹配不到,会被误判成 `stale`。现在按全部库目录匹配;
  库路径按大小写不敏感去重(注册表给的 `e:\steam` 和 vdf 里的 `E:\Steam` 是同一个库)。
- `steam_playtime` 的合计口径写明是「全部累计」,原来写成「合计」容易被读成前几名之和。
- 配置删掉 `activityWatchHost`、`activityMinutes`。`pollSeconds` 改成「重启生效」——
  检测间隔在 World 挂载时就定死了,原来标成热更新是错的。
- `steam_now` 的工具描述不再承诺「本次会话时长」:回执里本来就没有这个数。
  环境提示词补了一句「Steam 的时长是累计值,不是这一次玩了多久」。
- 文案去掉具体人名,事件与环境提示词改成通用说法,方便给别人用。
- 删掉没有接线的 `fetchPlayerSummary` / `fetchStoreInfo`,以及一批没人用的时间工具函数。
- 补齐发布所需的清单:`os`、`cortico.tags`、`cortico.locales`、`CHANGELOG.md`、`tsconfig.json`、
  `pnpm-workspace.yaml`、单元测试;并按 `describe:extension` 重新生成 `describe.json`。
