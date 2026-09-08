/**
 * @vitest-environment jsdom
 *
 * The other inpage tests exercise the TypeScript factories. This one runs what a
 * page actually gets — the built IIFE from dist — through the conformance tool
 * itself, so a bundling regression in one chain cannot pass unnoticed and the
 * tool is exercised by the package's own suite.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { checkInpageBundle, type ConformanceReport } from "../../src/conformance/index";
import { availableBundles, buildPreamble } from "../../src/script/build";
import type { ChainFamily } from "../../src/protocol/networks";
import { configFor, IDENTITY } from "./fake-transport";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = resolve(root, "dist/inpage");

/** Every generated bundle file, so a missing one still triggers the build below. */
const BUNDLE_FILES = ["btc", "cardano", "evm", "solana", "tron", "xrp", "xrp-standard"] as const;

/** Files that make up each family's injected surface. XRP ships two. */
const BUNDLE_FILES_FOR: Record<ChainFamily, readonly string[]> = {
  evm: ["evm"],
  solana: ["solana"],
  cardano: ["cardano"],
  tron: ["tron"],
  xrp: ["xrp", "xrp-standard"],
  btc: ["btc"],
};

async function missingBundles(): Promise<boolean> {
  for (const name of BUNDLE_FILES) {
    try {
      await stat(resolve(distDir, `${name}.iife.js`));
    } catch {
      return true;
    }
  }
  return false;
}

async function buildBundlesIfMissing(): Promise<void> {
  if (!(await missingBundles())) return;
  await promisify(execFile)(
    process.execPath,
    [resolve(root, "scripts/bundle-inpage.mjs"), "--force"],
    { cwd: root },
  );
}

/** Concatenated the way a host assembles them, with nothing added between. */
async function sourceFor(...families: ChainFamily[]): Promise<string> {
  const names = families.flatMap((family) => BUNDLE_FILES_FOR[family]);
  const files = await Promise.all(
    names.map((name) => readFile(resolve(distDir, `${name}.iife.js`), "utf8")),
  );
  return files.join("\n");
}

const ALL_FAMILIES = Object.keys(BUNDLE_FILES_FOR) as ChainFamily[];

/** Everything a bundle is allowed to leave on the window it ran in. */
const DOCUMENTED_GLOBALS = new Set([
  "ethereum",
  "cardano",
  "tronLink",
  "tronWeb",
  "crossmark",
  "__inpageWalletInstalled",
  "__inpageWalletDeliver",
]);

/** An iframe is the cheapest fresh window: no leftover provider, no leftover flag. */
function freshWindow(): Window & typeof globalThis {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const win = frame.contentWindow as (Window & typeof globalThis) | null;
  if (!win) throw new Error("the iframe has no window");
  return win;
}

function explain(report: ConformanceReport): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.family ?? "-"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`)
    .join("\n");
}

describe("built chain bundles", () => {
  it("lists a bundle for every family", async () => {
    await buildBundlesIfMissing();
    expect(availableBundles()).toEqual([...BUNDLE_FILES].sort());
  });

  it.each(Object.keys(BUNDLE_FILES_FOR) as ChainFamily[])(
    "passes conformance for %s",
    async (family) => {
      await buildBundlesIfMissing();
      const source = await sourceFor(family);

      const report = await checkInpageBundle(
        source,
        { identity: IDENTITY, families: [family] },
        { window: freshWindow() },
      );

      expect(report.ok, explain(report)).toBe(true);
    },
  );

  // A single scope is what a host injects: minified helpers hoisted above a
  // bundle's own wrapper would be shared, and every family but the last would
  // post envelopes built from another bundle's copy.
  for (const [label, families] of [
    ["registration order", ALL_FAMILIES],
    ["reverse order", [...ALL_FAMILIES].reverse()],
  ] as const) {
    it(`passes conformance with every family in one document, in ${label}`, async () => {
      await buildBundlesIfMissing();
      const source = await sourceFor(...families);

      const report = await checkInpageBundle(
        source,
        { identity: IDENTITY, families: [...families] },
        { window: freshWindow() },
      );

      expect(report.ok, explain(report)).toBe(true);
    });
  }

  it.each(BUNDLE_FILES)("leaves no top-level binding on the page: %s", async (name) => {
    await buildBundlesIfMissing();
    const win = freshWindow() as Window & typeof globalThis & { eval(code: string): unknown };
    win.eval(buildPreamble(configFor(ALL_FAMILIES)));

    const before = new Set(Object.getOwnPropertyNames(win));
    win.eval(await readFile(resolve(distDir, `${name}.iife.js`), "utf8"));

    const added = Object.getOwnPropertyNames(win).filter(
      (key) => !before.has(key) && !DOCUMENTED_GLOBALS.has(key),
    );
    expect(added).toEqual([]);
  });
});
