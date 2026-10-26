import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 两个测试文件并行时,会在同一个临时 ssr 缓存目录里抢写同一批模块文件,受限环境
    // (沙箱、只读临时目录)下会直接 EPERM 让一个文件的测试整批中止。测试量很小,串行更稳。
    fileParallelism: false,
  },
});
