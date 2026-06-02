const path = require("path");

module.exports = {
  apps: [
    {
      name: "pureXBT",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        WALLET_ID: "Fifb143PcvK15N9zVULLUqz3mS6uAMHaSSCrmmLPURE",
      },
    },
    {
      name: "discord-listener",
      script: "index.js",
      cwd: path.join(__dirname, "discord-listener"),
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
