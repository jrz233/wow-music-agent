#!/usr/bin/env node
/**
 * 把「这份源码来自哪个提交」写进 `src/generated/commit.ts`。
 *
 * 为什么需要它：wow-server 靠**上游仓库的最新提交号**判断用户部署的 Agent 是不是
 * 旧版。服务端看不到用户的仓库，只能问 Agent 自己——而 Agent 是在**构建那一刻**被
 * 打包的，所以提交号只能在构建时写进产物。
 *
 * 三条边界，每一条都是踩过的坑：
 *
 *   - **写出来的文件不进 git。** 它被 `.gitignore` 忽略：一旦把它提交上去，用户的
 *     仓库就变脏，`git pull` 同步上游时会被 git 拦下来——那正好破坏我们想推荐的
 *     同步流程。
 *   - **永远不失败。** 没有 git、不是 git 仓库、HEAD 取不到……任何一种情况都只是
 *     写一个空提交号（服务端据此不提示更新），绝不让 `npm ci` 或 `wrangler deploy`
 *     挂掉。构建失败对用户来说比「少一条提醒」糟糕得多。
 *   - **只认「仓库根就是 Agent 本体」的情况。** wow-server 单仓库里 `agent/` 只是
 *     子目录，那里的提交号属于 wow-server，和上游镜像不是一回事——比了永远不等，
 *     等于给用户一条永远消不掉的提醒。不如不提示。
 *
 * 这个脚本由三处调用，覆盖了所有部署姿势：`npm install`（prepare）、npm 的
 * `predeploy`/`pretypecheck`/`pretest` 钩子，以及 wrangler.toml 里的 `[build]`——
 * 最后这一处保证连 `npx wrangler deploy` 这种绕过 npm 的部署也会重新盖章。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Agent 本体目录（脚本在 scripts/ 下，源码在 ../）。 */
const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(AGENT_DIR, "src", "generated", "commit.ts");
/** 提交号形状：7–64 位小写十六进制。 */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

/** 跑一条 git 命令；任何异常都当成「拿不到」。 */
function git(args) {
  try {
    return execFileSync("git", ["-C", AGENT_DIR, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * 源码所在的 git 仓库根；拿不到（或不是 Agent 本体）时返回空串。
 *
 * 只认「仓库根 == Agent 目录」：上游镜像 `jrz233/wow-music-agent` 的根就是 Agent
 * 本体，用户的 fork 也是。而在 wow-server 单仓库里，Agent 只是 `agent/` 子目录。
 */
function sourceRepo() {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root || resolve(root) !== AGENT_DIR) {
    return "";
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest?.name !== "wow-music-agent") {
      return "";
    }
  } catch {
    return "";
  }
  return root;
}

/** 当前源码的提交号；判断不出来时返回空串。 */
function currentCommit() {
  // Cloudflare Workers Builds 会把这次构建对应的提交号塞进环境变量，它比本地
  // git 更权威（构建机上未必有 .git 目录）。
  const fromBuild = String(process.env.WORKERS_CI_COMMIT_SHA ?? "")
    .trim()
    .toLowerCase();
  if (COMMIT_PATTERN.test(fromBuild)) {
    return fromBuild;
  }
  if (!sourceRepo()) {
    return "";
  }
  const head = git(["rev-parse", "HEAD"]).toLowerCase();
  return COMMIT_PATTERN.test(head) ? head : "";
}

function render(commit) {
  return `// 由 scripts/stamp-commit.mjs 生成：不要手改，也不要提交（.gitignore 已忽略）。
//
// 空串表示「这份源码不是从 git 仓库里来的」——wow-server 据此不提示更新，
// 而不是拿一个比不出来的值去误报。
export const BUILD_COMMIT = ${JSON.stringify(commit)};
`;
}

try {
  const content = render(currentCommit());
  mkdirSync(dirname(TARGET), { recursive: true });
  // 内容没变就不写：`wrangler dev` 的文件监视器会把一次写入变成一次重载，
  // 而反复重写同一个文件会变成重载循环。
  let previous = "";
  try {
    previous = readFileSync(TARGET, "utf8");
  } catch {
    previous = "";
  }
  if (previous !== content) {
    writeFileSync(TARGET, content, "utf8");
  }
} catch (error) {
  // 盖章失败不是构建失败：空提交号 = 不提示更新，仅此而已。
  console.warn(`[stamp-commit] 写入提交号失败，忽略：${error?.message ?? error}`);
}
