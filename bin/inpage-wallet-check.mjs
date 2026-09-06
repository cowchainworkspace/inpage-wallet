#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const USAGE =
  'Usage: inpage-wallet-check <bundle.js> --name "X" --rdns a.b.c --uuid <uuid> --families evm,solana [--channel c] [--cardano-key k]';

const KNOWN_FAMILIES = new Set(["evm", "solana", "cardano", "tron", "xrp", "btc"]);

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--name":
        args.name = argv[(i += 1)];
        break;
      case "--rdns":
        args.rdns = argv[(i += 1)];
        break;
      case "--uuid":
        args.uuid = argv[(i += 1)];
        break;
      case "--families":
        args.families = (argv[(i += 1)] ?? "")
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
        break;
      case "--channel":
        args.channel = argv[(i += 1)];
        break;
      case "--cardano-key":
        args.cardanoKey = argv[(i += 1)];
        break;
      default:
        positional.push(arg);
    }
  }
  args.bundlePath = positional[0];
  return args;
}

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.bundlePath || !args.name || !args.rdns || !args.uuid || !args.families?.length) {
    fail("Missing required arguments.");
    return;
  }
  const badFamily = args.families.find((f) => !KNOWN_FAMILIES.has(f));
  if (badFamily) {
    fail(`Unknown family "${badFamily}". Expected one of: ${[...KNOWN_FAMILIES].join(", ")}.`);
    return;
  }

  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    console.error(
      "inpage-wallet-check needs jsdom to evaluate a bundle, and it is not installed in this project.",
    );
    console.error("Install it with: pnpm add -D jsdom");
    process.exit(1);
    return;
  }

  const { checkInpageBundle } = await import("../dist/conformance/index.js");

  const source = await readFile(resolve(process.cwd(), args.bundlePath), "utf8");
  const dom = new JSDOM("", { url: "https://inpage-wallet-check.example", runScripts: "dangerously" });

  const report = await checkInpageBundle(
    source,
    {
      identity: { name: args.name, rdns: args.rdns, uuid: args.uuid },
      families: args.families,
      ...(args.channel !== undefined ? { channel: args.channel } : {}),
      ...(args.cardanoKey !== undefined ? { cardanoWalletKey: args.cardanoKey } : {}),
    },
    { window: dom.window },
  );

  for (const check of report.checks) {
    const status = check.ok ? "ok  " : "FAIL";
    const family = check.family ? ` [${check.family}]` : "";
    const detail = check.detail ? ` — ${check.detail}` : "";
    console.log(`${status}${family} ${check.name}${detail}`);
  }
  console.log(report.ok ? "\nconformant" : "\nNOT conformant");
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
