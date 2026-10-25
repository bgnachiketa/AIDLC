#!/usr/bin/env node
const { main } = await import("../dist/cli/main.js");
process.exit(await main(process.argv, "plan-aidlc"));
