import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { templateVarNames } from 'cortico/core/template.ts';
import { SteamWorld } from '../src/world.ts';

const PROMPT_FILE = fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url));

function makeWorld(patch: Record<string, unknown> = {}): SteamWorld {
  return new SteamWorld(
    {
      enabled: true,
      steamPath: 'E:\\definitely-not-a-steam-dir',
      steamId: '',
      apiKey: '',
      timeoutMs: 3000,
      ...patch,
    } as never,
    'Asia/Shanghai',
  );
}

describe('环境提示词的占位符', () => {
  it('模板里用到的每个占位符都有值(未声明的会原样留在提示词里)', () => {
    const names = templateVarNames(readFileSync(PROMPT_FILE, 'utf8'));
    expect(names.length).toBeGreaterThan(0);

    const vars = makeWorld().envPromptVars() ?? {};
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(vars, name), `缺少变量 ${name}`).toBe(true);
    }
  });

  it('读不到 Steam 时返回空串而不是抛错(空串会走模板的缺省文案)', () => {
    const vars = makeWorld().envPromptVars();
    expect(typeof vars['steam.now']).toBe('string');
    expect(typeof vars['steam.account']).toBe('string');
  });

  it('每个占位符都写了缺省文案,免得出现「现在在玩。」这种残句', () => {
    const template = readFileSync(PROMPT_FILE, 'utf8');
    for (const name of templateVarNames(template)) {
      const bare = new RegExp(`\\{\\{\\s*${name.replace('.', '\\.')}\\s*\\}\\}`);
      expect(bare.test(template), `${name} 没有 | 缺省文案`).toBe(false);
    }
  });

  it('模板用到的占位符都在 promptDocs.vars 里声明了', () => {
    // 框架只拿声明过的名字去取值:漏声明时编辑器会报「未提供值,占位符将原样保留」,
    // 而 envPromptVars() 其实照常有值——两条链各说各话。
    const doc = makeWorld().webUi('zh').promptDocs?.find((d) => d.role === 'envPrompt');
    expect(doc, 'World 该声明 role=envPrompt 的模板').toBeTruthy();

    const declared = (doc!.vars ?? []).map((v) => v.name).sort();
    const used = templateVarNames(readFileSync(PROMPT_FILE, 'utf8')).sort();
    expect(declared, '模板用到的占位符都要在 vars 里声明').toEqual(used);
  });

  it('声明的每个占位符都有说明文案', () => {
    const doc = makeWorld().webUi('zh').promptDocs?.find((d) => d.role === 'envPrompt');
    for (const variable of doc!.vars ?? []) {
      expect(variable.description?.trim(), `${variable.name} 缺说明`).toBeTruthy();
    }
  });
});
