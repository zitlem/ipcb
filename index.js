#!/usr/bin/env node
/**
 * ipcb — HTTP API + MCP server for inter-process communication.
 *
 * Usage:
 *   node index.js [--port 9100] [--host 0.0.0.0]
 *
 * Endpoints:
 *   HTTP API:  http://<host>:<port>/channels, /signals, /status
 *   MCP SSE:   http://<host>:<port>/mcp/sse
 */
const { Broker } = require("./broker");
const { createHttpApi } = require("./http-api");
const { mountMcp } = require("./mcp-server");

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg("--port", "9100"), 10);
const HOST = getArg("--host", "0.0.0.0");

// Get the machine's LAN IP for the paste-ready command
function getLanIp() {
  const nets = require("os").networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) return cfg.address;
    }
  }
  return "localhost";
}

// Build everything
const broker = new Broker();
const app = createHttpApi(broker);
const baseUrl = `http://${getLanIp()}:${PORT}`;
const transports = mountMcp(app, broker, baseUrl);

// Landing page
app.get("/", (_req, res) => {
  const ip = getLanIp();
  res.json({
    name: "ipcb",
    version: "2.0.0",
    endpoints: {
      peers: {
        "POST /peers/register": "Register a peer { role, capabilities }",
        "DELETE /peers/:id": "Unregister peer",
        "POST /peers/:id/heartbeat": "Keep-alive",
        "GET  /peers": "List all peers",
      },
      commands: {
        "POST /commands/send": "Send command { from, target, action, params }",
        "GET  /commands/:peerId": "Get commands for peer (?since=0)",
        "GET  /commands/:peerId/wait": "Wait for command (?timeout=30000)",
        "POST /commands/:id/ack": "Acknowledge command { result }",
        "GET  /commands": "List all commands",
      },
      channels: {
        "POST /channels/:name/send": "Send message (?from=peerId)",
        "GET  /channels/:name/messages?since=0": "Read messages",
        "GET  /channels": "List channels",
      },
      signals: {
        "POST /signals/:name": "Emit signal (?from=peerId)",
        "GET  /signals/:name/wait?timeout=30000": "Wait for signal",
        "GET  /signals/:name": "Check signal",
        "GET  /signals": "List signals",
      },
      system: {
        "GET  /status": "Broker status",
        "POST /reset": "Reset all state",
        "GET  /dashboard": "Web dashboard",
        "GET  /events": "SSE event stream",
      },
      mcp: {
        "GET  /mcp/sse": "SSE MCP transport",
        "POST /mcp/messages": "MCP message handler",
      },
    },
    usage: {
      mcp_config: {
        mcpServers: {
          "ipcb": {
            type: "sse",
            url: `http://${ip}:${PORT}/mcp/sse`,
          },
        },
      },
      curl_example: `curl -X POST http://${ip}:${PORT}/channels/test/send -H 'Content-Type: application/json' -d '{"hello":"world"}'`,
    },
  });
});

app.listen(PORT, HOST, () => {
  const ip = getLanIp();
  const url = `http://${ip}:${PORT}/mcp/sse`;
  console.log(`\n  ipcb running on http://${HOST}:${PORT}\n`);
  console.log(`  Dashboard: http://${ip}:${PORT}/dashboard`);
  console.log(`  HTTP API:  http://${ip}:${PORT}/`);
  console.log(`  MCP SSE:   ${url}`);
  console.log(`\n  Add MCP server (paste into your terminal):`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  Claude Code:  claude mcp add --transport sse ipcb ${url}`);
  console.log(`  Cursor:       Add SSE server in Settings → MCP → url: ${url}`);
  console.log(`  Windsurf:     Add SSE server in Settings → MCP → url: ${url}`);
  console.log(`  .mcp.json:    { "mcpServers": { "ipcb": { "type": "sse", "url": "${url}" } } }`);
  console.log();
});
