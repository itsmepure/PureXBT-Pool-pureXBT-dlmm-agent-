// Standalone dashboard server — runs persistently until Ctrl+C
// Usage: $env:OPENAI_API_KEY="sk-test"; node run-dashboard.js
import { startDashboard } from "./dashboard.js";

console.log("PureXBT Pool Dashboard");
console.log("Open: http://127.0.0.1:3000");
console.log("Press Ctrl+C to stop");
startDashboard();

// Keep alive
process.stdin.resume();
