// Unit tests for computeAthSoftCap
// Run: node deploy/test/test-ath-soft-cap.js

import { computeAthSoftCap } from "../tools/screening.js";

let passed = 0;
let failed = 0;

function assertEq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  \u2713 ${name}`);
    passed++;
  } else {
    console.log(`  \u2717 ${name}`);
    console.log(`    Expected: ${JSON.stringify(expected)}`);
    console.log(`    Got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

const cfgOn = { athSoftCapEnabled: true, athSoftCapPct: 15, athSoftCapMaxScore: 40 };
const cfgOff = { athSoftCapEnabled: false, athSoftCapPct: 15, athSoftCapMaxScore: 40 };

console.log("computeAthSoftCap tests:");

// Test 1: ATH 5% from top -> cap
assertEq("ATH 5% caps score 80 -> 40",
  computeAthSoftCap(80, 5, cfgOn),
  { score: 40, capped: true, athDistance: 5 });

// Test 2: ATH 50% from top -> no cap
assertEq("ATH 50% no cap (score 80 unchanged)",
  computeAthSoftCap(80, 50, cfgOn),
  { score: 80, capped: false, athDistance: 50 });

// Test 3: disabled
assertEq("Disabled flag bypasses cap",
  computeAthSoftCap(80, 5, cfgOff),
  { score: 80, capped: false, athDistance: 5 });

// Test 4: no ATH data
assertEq("Null athDistance is pass-through",
  computeAthSoftCap(80, null, cfgOn),
  { score: 80, capped: false, athDistance: null });

// Test 5: score already below cap
assertEq("Score already below cap is unchanged",
  computeAthSoftCap(30, 5, cfgOn),
  { score: 30, capped: false, athDistance: 5 });

// Test 6: edge - exactly at threshold
assertEq("ATH exactly at threshold (15%) triggers cap",
  computeAthSoftCap(80, 15, cfgOn),
  { score: 40, capped: true, athDistance: 15 });

// Test 7: just over threshold
assertEq("ATH just over threshold (15.1%) no cap",
  computeAthSoftCap(80, 15.1, cfgOn),
  { score: 80, capped: false, athDistance: 15.1 });

// Test 8: infinity/non-finite
assertEq("Non-finite athDistance is pass-through",
  computeAthSoftCap(80, Infinity, cfgOn),
  { score: 80, capped: false, athDistance: null });

// Test 9: null config
assertEq("Null config is pass-through",
  computeAthSoftCap(80, 5, null),
  { score: 80, capped: false, athDistance: 5 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
