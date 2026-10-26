import { afterEach, describe, expect, it } from 'vitest';
import { currentProxy, normalizeProxy, resetProxyCache, setProxy } from '../src/http.ts';

afterEach(() => {
  resetProxyCache();
});

describe('normalizeProxy', () => {
  it('补 http:// 与默认端口', () => {
    expect(normalizeProxy('127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(normalizeProxy('http://127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(normalizeProxy('https://proxy.local')).toBe('https://proxy.local');
  });

  it('空值与非 URL 返回空串(当直连)', () => {
    expect(normalizeProxy('')).toBe('');
    expect(normalizeProxy('   ')).toBe('');
    expect(normalizeProxy('http://')).toBe('');
  });
});

describe('setProxy / currentProxy', () => {
  it('direct / off / none 都表示直连', () => {
    for (const value of ['direct', 'OFF', 'none']) {
      setProxy(value);
      expect(currentProxy()).toBe('');
    }
  });

  it('填了地址就用地址', () => {
    setProxy('127.0.0.1:7897');
    expect(currentProxy()).toBe('http://127.0.0.1:7897');
  });

  it('空值回到 auto(不抛错,读不到系统代理就当直连)', () => {
    setProxy('');
    expect(typeof currentProxy()).toBe('string');
  });
});
