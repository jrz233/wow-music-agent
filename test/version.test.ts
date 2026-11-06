import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENT_VERSION } from "../src/env";

/** `agent/package.json` 的绝对路径（从本测试文件往上退一级）。 */
const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

/**
 * 版本号的两份拷贝必须一致。
 *
 * `AGENT_VERSION` 是运行时上报给 wow-server 的（`/v1/status` 的 `agentVersion`），
 * `package.json` 的 `version` 是 npm 与发布流程看的。两份各写各的、忘了同步，
 * 面板上就会出现「版本号说 0.2.0、包里却是 0.1.0」这种没法解释的组合。
 *
 * 顺带把「版本号本身可不可信」这件事钉下来：**它只是一句自述**，所以 wow-server
 * 判断「有没有新版」用的是提交号而不是它（见 `internal/features/agentupdate`）。
 * 这条用例防的是两份拷贝漂移，防不了「忘了 bump」——那是提交号那条路的活。
 */
describe("版本号", () => {
  it("package.json 与运行时上报的版本号一致", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      version?: string;
    };

    expect(manifest.version).toBe(AGENT_VERSION);
  });

  it("版本号是三段式语义化版本", () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
