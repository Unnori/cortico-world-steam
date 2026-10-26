# cortico-world-steam

**让桌宠知道你 Steam 上在玩什么、玩多久、成就差哪几个,以及这款游戏现在值不值得买。**

Coopanion / Cortico 的 World 扩展。只读本地记录,不写 Steam 任何文件。

[![npm](https://img.shields.io/npm/v/cortico-world-steam?color=2f6feb)](https://www.npmjs.com/package/cortico-world-steam)
[![license](https://img.shields.io/badge/license-MIT-2f6feb)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows-2f6feb)](#前置条件)

- **零配置可用** —— 昵称、在玩什么、每款时长、库、成就,全部读本机
- **价格不糊弄** —— 现价是 Steam 官方国区价,史低是 IsThereAnyDeal 的国区口径,不做美元换算
- **只读** —— 不写 Steam 文件、不启动游戏、不上传任何记录

<!-- 截图:装好后从「高级模式 → World 总览 → Steam」截一张,放这里 -->

## 前置条件

Windows + 装过 Steam 客户端。Steam 没开着也能查历史,只是查不到「正在玩」。

## 快速开始

1. 扩展页搜 `cortico-world-steam` → 安装 → 重启应用
2. 「World 总览」里找到 **Steam**,点**激活**(默认是关的,**这步别漏**)
3. 直接问:「我在玩什么」「星露谷的成就还差几个」「艾尔登法环现在史低多少」

## 它能做什么

| 你说 | 它做 |
|---|---|
| 我在玩什么 / 玩多久了 | 现在在玩的游戏 + 累计时长 |
| 我最近在玩什么 | 最近两周的游玩记录 |
| 我库里有什么 / 有什么没玩过 | 库列表,按已安装/玩过/没碰过筛 |
| 我的成就打得怎么样 / 还差哪几个 | 成就进度,缺的按全服稀有度排 |
| 这游戏多少钱 / 现在打折吗 / 史低多少 | 你所在区的现价 + 历史最低 |
| 你知道我的 Steam 叫什么吗 | 昵称、在线状态、资料公开性 |
| 谁在线 / XX 在玩什么 | 好友状态(**默认关闭**) |
| 这个能用吗 / 哪里出了问题 | 自检:路径、账号、key、网络 |

## 装好之后(可选)

不配任何 key 也能用。下面两个都免费,填在「Steam API key」面板里:

| key | 补上什么 |
|---|---|
| Steam Web API key | 未安装游戏的名字、最近两周各玩了多久、成就明细、好友在线 |
| IsThereAnyDeal key | 历史最低价(现价不需要 key) |

申请方式见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#申请-key)。

## 隐私

- **只读**:不写 Steam 任何文件,不启动/关闭游戏,不读截图内容(只数数量和时间)
- **不配 key 时完全离线**;联网只发生在补游戏名、成就、价格、好友这几件事上
- 好友数据默认不读,要在配置里手动打开
- 登录用的账号名(`AccountName`)不读;SteamID64、真实名、注册时间只在私下说,不主动念

## 常见问题

**为什么有些游戏显示成 `appid 246620`?**
Steam 本地只存 appid。装着的能从 `appmanifest` 补名字,玩过但已卸载的就只有数字——配 Steam Web API key 就能补上。

**问「谁在线」说查不到?**
Steam 要求好友列表**公开**才给数据,否则这个接口直接 401。没有绕过办法,插件会如实说「拿不到」,不会编人名。

**国内很慢 / 一直转圈?**
Steam 域名直连国内会挂住。开着 Clash 就不用管——插件自己读系统代理,不依赖环境变量。

**成就数字和别人不一样?**
隐藏成就不列,没写 apiName 的条目会跳过;总数以 Steam 自己的 `nAchieved/nTotal` 为准。

## 开发

数据来源、交叉校验、价格与代理的实现细节、占位符、打包发布流程,都在
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 许可

MIT
