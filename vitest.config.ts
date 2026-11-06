import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 测试只做纯函数/加密/映射，不并发起多个 worker；限制单进程避免占满小机器。
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
  },
});
