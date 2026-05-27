// Quick test: start dashboard server standalone
import { startDashboard, stopDashboard } from "./dashboard.js";

console.log("Starting dashboard on http://127.0.0.1:3000 ...");
startDashboard();

setTimeout(async () => {
  try {
    const res = await fetch("http://127.0.0.1:3000/api/health");
    const data = await res.json();
    console.log("HEALTH:", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Health check failed:", e.message);
  }
}, 1000);

setTimeout(async () => {
  try {
    const res = await fetch("http://127.0.0.1:3000/");
    const html = await res.text();
    console.log("UI served:", html.length, "bytes, status:", res.status);
  } catch (e) {
    console.error("UI fetch failed:", e.message);
  }
  stopDashboard();
  console.log("Dashboard stopped. Test complete.");
  process.exit(0);
}, 2000);
