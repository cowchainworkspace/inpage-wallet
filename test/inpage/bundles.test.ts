/**
 * @vitest-environment jsdom
 *
 * The other inpage tests exercise the TypeScript factories. This one runs what a
 * page actually gets — the built IIFE from dist — so a bundling regression in one
 * chain cannot pass unnoticed.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { availableBundles, buildPreamble } from "../../src/script/build";
import { configFor, IDENTITY } from "./fake-transport";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = resolve(root, "dist/inpage");

/** Every bundle, with the family whose networks make it install. */
const BUNDLES = [
  { name: "btc", family: "btc" },
  { name: "cardano", family: "cardano" },
  { name: "evm", family: "evm" },
  { name: "solana", family: "solana" },
  { name: "tron", family: "tron" },
  { name: "xrp", family: "xrp" },
  { name: "xrp-standard", family: "xrp" },
] as const;

type TestWindow = Window &
  typeof globalThis & {
    ReactNativeWebView?: { postMessage(data: string): void };
    cardano?: Record<string, unknown>;
    tronLink?: unknown;
    crossmark?: unknown;
  };

type Announced = { info: { rdns: string } };
type Registered = { name: string };

type Page = {
  win: TestWindow;
  posted: string[];
  announced: Announced[];
  registered: Registered[];
};

async function missingBundles(): Promise<boolean> {
  for (const { name } of BUNDLES) {
    try {
      await stat(resolve(distDir, `${name}.iife.js`));
    } catch {
      return true;
    }
  }
  return false;
}

beforeAll(async () => {
  if (!(await missingBundles())) return;
  await promisify(execFile)(
    process.execPath,
    [resolve(root, "scripts/bundle-inpage.mjs"), "--force"],
    { cwd: root },
  );
}, 180_000);

/** An iframe is the cheapest fresh window: no leftover provider, no leftover flag. */
function load(family: (typeof BUNDLES)[number]["family"], iife: string): Page {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const win = frame.contentWindow as TestWindow | null;
  if (!win) throw new Error("the iframe has no window");

  const posted: string[] = [];
  const announced: Announced[] = [];
  const registered: Registered[] = [];

  win.ReactNativeWebView = {
    postMessage: (data) => {
      posted.push(data);
    },
  };
  win.addEventListener("eip6963:announceProvider", (event) => {
    announced.push((event as CustomEvent<Announced>).detail);
  });
  win.addEventListener("wallet-standard:register-wallet", (event) => {
    const detail = (event as unknown as { detail: (api: { register(w: unknown): void }) => void })
      .detail;
    detail({ register: (wallet) => registered.push(wallet as Registered) });
  });

  win.eval(buildPreamble(configFor([family])));
  win.eval(iife);
  return { win, posted, announced, registered };
}

describe("built chain bundles", () => {
  it("fires each family's discovery hook in a fresh page", async () => {
    expect(availableBundles()).toEqual(BUNDLES.map((b) => b.name));

    for (const bundle of BUNDLES) {
      const iife = await readFile(resolve(distDir, `${bundle.name}.iife.js`), "utf8");
      const page = load(bundle.family, iife);

      switch (bundle.name) {
        case "evm":
          expect(page.announced.map((a) => a.info.rdns)).toEqual([IDENTITY.rdns]);
          break;
        case "solana":
        case "btc":
        case "xrp-standard":
          expect(page.registered.map((w) => w.name)).toEqual([IDENTITY.name]);
          break;
        case "cardano":
          expect(Object.keys(page.win.cardano ?? {})).toHaveLength(1);
          break;
        case "tron":
          expect(page.win.tronLink).toBeDefined();
          break;
        case "xrp":
          expect(page.win.crossmark).toBeDefined();
          break;
      }

      expect(page.posted).toHaveLength(1);
    }
  });
});
