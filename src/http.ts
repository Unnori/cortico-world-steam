/**
 * 所有对外请求走这里。
 *
 * 为什么需要:Node 的 fetch **不读 Windows 系统代理**。开着 Clash 时浏览器很快,
 * 插件却是直连——Steam 的域名直连在国内又慢又容易挂住,看起来就像"被限流"。
 * 所以这里自己读系统代理,并用 undici 的 ProxyAgent 走它。
 *
 * 代理拿不到(或 undici 不在)就退回直连,不让整个功能挂掉。
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
}

/** 用户配置的代理:`auto` 自动读系统代理,`direct`/`none`/`off` 直连,其余当地址。 */
let configured = 'auto';

export function setProxy(value: string | undefined): void {
  const text = (value ?? '').trim();
  configured = text || 'auto';
}

/** 当前用的代理地址;空串=直连。 */
export function currentProxy(): string {
  const value = configured.toLowerCase();
  if (value === 'direct' || value === 'none' || value === 'off') return '';
  if (value !== 'auto') return normalizeProxy(configured);
  return systemProxy();
}

let proxyCache: { at: number; value: string } | null = null;

/** 读 Windows 系统代理(Clash / v2ray 之类会写这里),5 分钟内复用。 */
export function systemProxy(): string {
  const now = Date.now();
  if (proxyCache && now - proxyCache.at < 5 * 60_000) return proxyCache.value;

  // 顺序:系统代理(用户意图) → 注册表的 ps 兜底 → 环境变量(开发者/沙箱常用)
  let value = '';
  if (process.platform === 'win32') value = registryProxy('reg') || registryProxy('ps');
  if (!value) value = envProxy();
  proxyCache = { at: now, value };
  return value;
}

/** 有些用户把代理写在环境变量里,先看这里。 */
function envProxy(): string {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = (process.env[name] ?? '').trim();
    if (value) return normalizeProxy(value);
  }
  return '';
}

const PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 读注册表里的 ProxyEnable/ProxyServer;失败(命令不存在、被策略拦)返回空串。 */
function registryProxy(via: 'reg' | 'ps'): string {
  try {
    if (via === 'reg') {
      const out = execFileSync('reg', ['query', PROXY_REG_KEY], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
      const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)?.[1]?.trim() ?? '';
      return enabled && server ? pickProxy(server) : '';
    }
    // 注册表路径在 ps 里要带盘符冒号(HKCU:\),否则会被当成相对文件路径
    const psKey = PROXY_REG_KEY.replace(/^HKCU\\/, 'HKCU:\\');
    const script =
      `Get-ItemProperty '${psKey}' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    });
    const parsed = JSON.parse(out) as { ProxyEnable?: number; ProxyServer?: string };
    return Number(parsed.ProxyEnable ?? 0) === 1 && parsed.ProxyServer ? pickProxy(parsed.ProxyServer) : '';
  } catch {
    return '';
  }
}

/** 系统里可能写成 `http=127.0.0.1:7897;https=127.0.0.1:7897`,挑一个能用的。 */
function pickProxy(server: string): string {
  const parts = server
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const https = parts.find((item) => /^https=/i.test(item));
  const http = parts.find((item) => /^http=/i.test(item));
  const plain = parts.find((item) => !item.includes('='));
  const chosen = https ?? http ?? plain ?? '';
  return normalizeProxy(chosen.replace(/^[a-z]+=/i, ''));
}

/** 补 scheme 与默认端口,校验一下能不能当 URL 用。 */
export function normalizeProxy(value: string): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return '';
    if (!url.port && url.protocol === 'http:') url.port = '80';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/** 测试用:清掉系统代理缓存。 */
export function resetProxyCache(): void {
  proxyCache = null;
  configured = 'auto';
}

interface UndiciModule {
  fetch: (input: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  ProxyAgent: new (url: string) => unknown;
}

let undiciPromise: Promise<UndiciModule | null> | null = null;

/**
 * undici 跟着宿主应用一起来(`resources/app/node_modules/undici`),但不在扩展自己的
 * 解析路径里,所以按绝对路径动态 import。拿不到就返回 null,退回直连。
 */
async function loadUndici(): Promise<UndiciModule | null> {
  if (!undiciPromise) {
    undiciPromise = (async () => {
      // resourcesPath 只有 Electron 有,@types/node 里没有,这里按可选字段取
      const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
      const candidates = [
        // Electron:resources/app/node_modules/undici
        resourcesPath ? join(resourcesPath, 'app', 'node_modules', 'undici', 'index.js') : '',
        // 便携版:exe 同级的 resources/app
        join(dirname(process.execPath), 'resources', 'app', 'node_modules', 'undici', 'index.js'),
        // 从应用根目录启动时
        join(process.cwd(), 'node_modules', 'undici', 'index.js'),
      ];
      for (const file of candidates) {
        if (!file || !existsSync(file)) continue;
        try {
          const mod = (await import(pathToFileURL(file).href)) as unknown as UndiciModule;
          if (typeof mod?.fetch === 'function' && typeof mod?.ProxyAgent === 'function') return mod;
        } catch {
          // 试下一个
        }
      }
      return null;
    })();
  }
  return undiciPromise;
}

/** 当前实际生效的网络方式,给状态页用。 */
export interface HttpStatus {
  /** 配置/系统代理地址;空串=没配 */
  proxy: string;
  /** 真能走代理吗(需要 undici 的 ProxyAgent) */
  usable: boolean;
}

export async function httpStatus(): Promise<HttpStatus> {
  const proxy = currentProxy();
  if (!proxy) return { proxy: '', usable: false };
  return { proxy, usable: Boolean(await loadUndici()) };
}

/** 发起一次请求;网络层失败返回 null(HTTP 4xx/5xx 不算失败,返回 ok=false)。 */
export async function httpRequest(url: string, init: HttpInit): Promise<HttpResult | null> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { 'User-Agent': 'cortico-world-steam/0.7', ...init.headers };
  const signal = AbortSignal.timeout(init.timeoutMs || 12000);
  const proxy = currentProxy();

  if (proxy) {
    const undici = await loadUndici();
    if (undici) {
      try {
        const response = await undici.fetch(url, {
          method,
          headers,
          signal,
          ...(init.body ? { body: init.body } : {}),
          dispatcher: new undici.ProxyAgent(proxy),
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      } catch {
        // 代理不通就直连再试一次
      }
    }
  }

  try {
    const response = await fetch(url, { method, headers, signal, ...(init.body ? { body: init.body } : {}) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}
