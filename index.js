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
const { createMcpServer, mountMcpOnExpress } = require("./mcp-server");

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg("--port", "9100"), 10);
const HOST = getArg("--host", "0.0.0.0");

// Build everything
const broker = new Broker();
const app = createHttpApi(broker);
const mcpResult = createMcpServer(broker);
const transports = mountMcpOnExpress(app, mcpResult);

// Landing page
app.get("/", (_req, res) => {
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
            url: `http://localhost:${PORT}/mcp/sse`,
          },
        },
      },
      curl_example: `curl -X POST http://localhost:${PORT}/channels/test/send -H 'Content-Type: application/json' -d '{"hello":"world"}'`,
    },
  });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  ipcb running on http://${HOST}:${PORT}\n`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  HTTP API:  http://localhost:${PORT}/`);
  console.log(`  MCP SSE:   http://localhost:${PORT}/mcp/sse`);
  console.log(`\n  Paste this into your chatbot terminal to connect:`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  claude mcp add --transport sse ipcb http://localhost:${PORT}/mcp/sse`);
  console.log();
});
