/**
 * 这份 Agent 源码的提交号。
 *
 * 来自构建时盖章（`scripts/stamp-commit.mjs` 写进 `src/generated/commit.ts`）：
 * Agent 是在构建那一刻被打包的，运行时已经拿不到 git 信息了。
 *
 * 服务端拿它和**上游仓库的最新提交号**比一比，就知道用户部署的是不是旧版——
 * 这条判断只在两边都有提交号时才成立，所以这里把不合法的值一律收敛成空串：
 * 宁可「比不出来」，也不要拿版本号、UUID 之类的东西去比。
 */

import { BUILD_COMMIT } from "./generated/commit";

/** 提交号形状：7–64 位小写十六进制。 */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

export const AGENT_COMMIT = COMMIT_PATTERN.test(BUILD_COMMIT) ? BUILD_COMMIT : "";
