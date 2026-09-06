/**
 * The CLI shells out to jsdom and imports the built package, so this drives the
 * real thing end to end instead of re-testing `checkInpageBundle` in isolation.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { IDENTITY } from "../inpage/fake-transport";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = resolve(root, "bin/inpage-wallet-check.mjs");
const EVM_BUNDLE = resolve(root, "dist/inpage/evm.iife.js");

async function missingDist(): Promise<boolean> {
  try {
    await stat(EVM_BUNDLE);
    await stat(resolve(root, "dist/conformance/index.js"));
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  if (!(await missingDist())) return;
  await execFileAsync("pnpm", ["run", "build"], { cwd: root });
}, 180_000);

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], { cwd: root }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: number }) | null)?.code ?? 0;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("inpage-wallet-check CLI", () => {
  it("exits 0 and prints a conformant report for a real bundle", async () => {
    const { code, stdout } = await run([
      EVM_BUNDLE,
      "--name",
      IDENTITY.name,
      "--rdns",
      IDENTITY.rdns,
      "--uuid",
      IDENTITY.uuid,
      "--families",
      "evm",
    ]);

    expect(stdout).toContain("conformant");
    expect(stdout).not.toContain("NOT conformant");
    expect(code).toBe(0);
  });

  it("exits 1 and lists the failing checks when the family does not match the bundle", async () => {
    const { code, stdout } = await run([
      EVM_BUNDLE,
      "--name",
      IDENTITY.name,
      "--rdns",
      IDENTITY.rdns,
      "--uuid",
      IDENTITY.uuid,
      "--families",
      "solana",
    ]);

    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("NOT conformant");
    expect(code).toBe(1);
  });

  it("exits 1 with a usage message when required arguments are missing", async () => {
    const { code, stderr } = await run([EVM_BUNDLE]);

    expect(stderr).toContain("Usage: inpage-wallet-check");
    expect(code).toBe(1);
  });
});
