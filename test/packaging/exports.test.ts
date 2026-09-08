/**
 * The exports map is part of the API: a host on Jest, or any other CommonJS
 * resolver, sees only what `require` resolves. These cases run Node's own
 * resolver over the built package, so a missing condition fails here rather than
 * in someone else's test suite.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What the issue's Jest config had to reach around. */
const SUBPATHS = [
  "inpage-wallet",
  "inpage-wallet/host",
  "inpage-wallet/protocol",
  "inpage-wallet/inpage",
  "inpage-wallet/inpage/evm",
  "inpage-wallet/inpage/solana",
  "inpage-wallet/transports/rn-webview",
  "inpage-wallet/transports/post-message",
  "inpage-wallet/script",
  "inpage-wallet/conformance",
];

type ConditionBlock = Record<string, string | Record<string, string>>;

async function packageJson(): Promise<{ exports: Record<string, ConditionBlock | string> }> {
  return JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    exports: Record<string, ConditionBlock | string>;
  };
}

/** `pnpm test` does not build, so the packaging cases build what they inspect. */
async function buildIfMissing(): Promise<void> {
  try {
    await stat(resolve(root, "dist/index.cjs"));
    return;
  } catch {
    await promisify(execFile)(resolve(root, "node_modules/.bin/tsup"), [], { cwd: root });
  }
}

beforeAll(buildIfMissing, 180_000);

describe("the exports map", () => {
  it("resolves every subpath through Node's CommonJS resolver", () => {
    // Self-reference: the package's own name resolves through its exports map.
    const require = createRequire(resolve(root, "package.json"));

    for (const id of SUBPATHS) {
      const loaded = require(id) as Record<string, unknown>;
      expect(Object.keys(loaded).length, `${id} loaded nothing`).toBeGreaterThan(0);
    }
  });

  it("declares types first in every condition block", async () => {
    const { exports } = await packageJson();

    for (const [subpath, entry] of Object.entries(exports)) {
      if (typeof entry === "string") continue;
      for (const [condition, target] of Object.entries(entry)) {
        expect(typeof target, `${subpath} ${condition}`).toBe("object");
        expect(Object.keys(target as Record<string, string>)[0], `${subpath} ${condition}`).toBe(
          "types",
        );
      }
    }
  });

  it("offers both an import and a require condition for every subpath", async () => {
    const { exports } = await packageJson();

    for (const [subpath, entry] of Object.entries(exports)) {
      if (typeof entry === "string") continue;
      expect(Object.keys(entry).sort(), subpath).toEqual(["import", "require"]);
    }
  });

  it("keeps the package free of side effects so bundlers can still tree-shake", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      sideEffects: boolean;
      type: string;
    };

    expect(pkg.sideEffects).toBe(false);
    expect(pkg.type).toBe("module");
  });
});
