import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "protocol/index": "src/protocol/index.ts",
    "host/index": "src/host/index.ts",
    "inpage/index": "src/inpage/index.ts",
    "inpage/chains/evm": "src/inpage/chains/evm.ts",
    "inpage/chains/solana": "src/inpage/chains/solana.ts",
    "inpage/chains/cardano": "src/inpage/chains/cardano.ts",
    "inpage/chains/tron": "src/inpage/chains/tron.ts",
    "inpage/chains/tron-full": "src/inpage/chains/tron-full.ts",
    "inpage/chains/xrp": "src/inpage/chains/xrp.ts",
    "inpage/chains/xrp-standard": "src/inpage/chains/xrp-standard.ts",
    "inpage/chains/btc": "src/inpage/chains/btc.ts",
    "transports/post-message": "src/transports/post-message.ts",
    "transports/rn-webview": "src/transports/rn-webview.ts",
    "transports/extension-content-script": "src/transports/extension-content-script.ts",
    "script/index": "src/script/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: { compilerOptions: { types: [] } },
  // Everything but the per-chain IIFEs, which scripts/bundle-inpage.mjs wrote
  // into the same directory before this ran.
  clean: ["**/*", "!inpage/*.iife.js"],
  splitting: true,
  sourcemap: false,
  treeshake: true,
  external: ["tronweb"],
});
