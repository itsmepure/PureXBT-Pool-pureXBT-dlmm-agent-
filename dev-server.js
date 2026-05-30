// Minimal dev server — serves dashboard files without dependencies
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3001;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath;

  if (url.pathname === "/" || url.pathname === "/index.html") {
    filePath = path.join(__dirname, "dashboard-ui.html");
  } else if (url.pathname === "/learning" || url.pathname === "/learning.html") {
    filePath = path.join(__dirname, "learning.html");
  } else if (url.pathname === "/learning-local" || url.pathname === "/learning-local.html") {
    filePath = path.join(__dirname, "learning-local.html");
  } else if (url.pathname === "/logo.svg") {
    filePath = path.join(__dirname, "logo.svg");
  } else {
    // For API paths — proxy or return mock
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (url.pathname === "/api/learning") {
        filePath = path.join(__dirname, "..", "lessons_vps.json");
        if (fs.existsSync(filePath)) {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const perf = raw.performance || [];
          const wins = perf.filter(p => (p.pnl_pct || 0) > 0);
          const losses = perf.filter(p => (p.pnl_pct || 0) < 0);
          return res.end(JSON.stringify({
            ok: true,
            data: {
              lessons: raw.lessons || [],
              performance: perf,
              evolution: (raw.lessons || []).filter(l => (l.tags || []).some(t => ["evolution","self_tune","config_change"].includes(t))),
              stats: {
                total_positions: perf.length, winners: wins.length, losers: losses.length,
                win_rate: perf.length ? ((wins.length/perf.length)*100).toFixed(1) : "0",
                best_pnl: wins.length ? Math.max(...wins.map(p=>p.pnl_pct||0)).toFixed(2) : "0",
                worst_pnl: losses.length ? Math.min(...losses.map(p=>p.pnl_pct||0)).toFixed(2) : "0",
              }
            }
          }));
        }
        return res.end(JSON.stringify({ ok: true, data: { lessons: [], performance: [], stats: {} }}));
      }
      if (url.pathname === "/api/learning/knowledge") {
        filePath = path.join(__dirname, "..", "agentlearning.md");
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end(fs.readFileSync(filePath, "utf8"));
        }
        return res.end("not found");
      }
      if (url.pathname === "/api/health") {
        return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      }
      return res.end(JSON.stringify({ ok: true, data: {}, note: "dev server — limited APIs" }));
    }

    // Static file fallback
    filePath = path.join(__dirname, url.pathname.slice(1));
  }

  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<h1>Not found: ${url.pathname}</h1><p>Available: <a href="/">dashboard</a> | <a href="/learning">learning</a> | <a href="/learning-local">learning (standalone)</a></p>`);
  }

  const ext = path.extname(filePath);
  const types = { ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".js": "application/javascript", ".json": "application/json" };
  res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Dashboard dev server running`);
  console.log(`  Dashboard:  http://localhost:${PORT}/`);
  console.log(`  Learning:   http://localhost:${PORT}/learning`);
  console.log(`  Standalone: http://localhost:${PORT}/learning-local`);
  console.log(`========================================\n`);
});
