// WP23 evidence module is importable without running its CLI (Task 10 imports classicMetrics).
// Run: npm run test:wp23-evidence   (node scripts/run-engine-tests.mjs wp23-evidence.test.mjs)
const mod = await import("./wp23-evidence.mjs");
let failed = 0;
const ok = (name, cond) => { if (cond) console.log("  ok   - " + name); else { failed++; console.log("  FAIL - " + name); } };
ok("importing the module does not run the CLI or exit", true);
ok("classicMetrics is exported as a function", typeof mod.classicMetrics === "function");
console.log("\nWP23 evidence import: " + (failed === 0 ? "passed" : failed + " failed"));
process.exit(failed === 0 ? 0 : 1);
