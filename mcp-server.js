/**
 * MCP (Model Context Protocol) adapter over the broker.
 * Exposes broker operations as MCP tools via SSE transport.
 * Each MCP session tracks its own peer identity after register().
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");

/**
 * Register all broker tools on an MCP server instance.
 * Called once per SSE connection so each gets its own McpServer.
 */
function registerTools(mcp, broker, sessionPeers, baseUrl) {

  // ── Tool: connect ──
  mcp.tool(
    "connect",
    `Connect this session to the IPC broker. This is the FIRST tool to call.

HOW TO USE THIS TOOL:
1. Call connect() with NO arguments first — it returns who's already online and what the project context is.
2. Based on that info, ASK THE USER:
   - "What role should this session play?" (show who's already connected)
   - "What should this session be responsible for?" (to determine capabilities)
   - "Should this session be the orchestrator or a worker?" (if no orchestrator exists yet)
3. Then call connect() AGAIN with role and capabilities filled in to complete registration.

This two-step flow means the user just says "connect to the broker" and you handle the rest.`,
    {
      role: z
        .string()
        .optional()
        .describe("Your role name. Leave empty on first call to discover who's online before choosing."),
      capabilities: z
        .array(z.string())
        .optional()
        .default([])
        .describe("What this session can do (e.g. ['airshow', 'network', 'tcp', 'testing'])"),
    },
    async ({ role, capabilities }, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;

      // Already connected?
      const existingPeerId = sid ? sessionPeers.get(sid) : null;
      if (existingPeerId) {
        const existingPeer = broker.getPeer(existingPeerId);
        if (existingPeer) {
          const peers = broker.listPeers();
          return {
            content: [
              {
                type: "text",
                text: `Already connected as '${existingPeer.role}' (${existingPeer.id}).\n\nAll peers online:\n${JSON.stringify(peers, null, 2)}`,
              },
            ],
          };
        }
      }

      // Discovery mode — no role provided, just show current state
      if (!role) {
        const peers = broker.listPeers();
        const hasOrchestrator = peers.some((p) => p.role === "orchestrator");
        const roles = peers.map((p) => p.role);
        const pending = broker.getAllCommands().filter((c) => c.status === "pending").length;

        let guidance = "=== IPC BROKER — CONNECTION WIZARD ===\n\n";

        if (peers.length === 0) {
          guidance += "No peers online yet. This is the first session to connect.\n\n";
          guidance += "ASK THE USER:\n";
          guidance += "1. What role should this session play? (e.g. 'orchestrator', 'backend', 'linux-client', 'tester')\n";
          guidance += "2. What will this session be doing? (determines capabilities)\n";
          guidance += "3. Will this session coordinate others (orchestrator) or execute tasks (worker)?\n";
        } else {
          guidance += `${peers.length} peer(s) already online:\n`;
          for (const p of peers) {
            guidance += `  - ${p.role} (${p.id}) — capabilities: [${p.capabilities.join(", ")}]\n`;
          }
          guidance += "\n";

          if (!hasOrchestrator) {
            guidance += "NOTE: No orchestrator registered yet. Consider making this session the orchestrator.\n\n";
          }

          guidance += "ASK THE USER:\n";
          guidance += "1. What role should THIS session play? (must be different from: " + roles.join(", ") + ")\n";
          guidance += "2. What capabilities does this session have?\n";
          if (!hasOrchestrator) {
            guidance += "3. Should this be the orchestrator (coordinates others) or a worker (executes tasks)?\n";
          }
        }

        guidance += "\nOnce the user answers, call connect() again with role and capabilities to complete registration.";
        if (pending > 0) {
          guidance += `\n\nNOTE: ${pending} pending command(s) in the broker.`;
        }

        return { content: [{ type: "text", text: guidance }] };
      }

      // Registration mode — role provided, register the peer
      try {
        const peer = broker.registerPeer(role, capabilities);
        if (sid) sessionPeers.set(sid, peer.id);

        const peers = broker.listPeers();
        let msg = `Connected as '${peer.role}' (${peer.id})\n`;
        msg += `Capabilities: [${peer.capabilities.join(", ")}]\n\n`;
        msg += `All peers online (${peers.length}):\n`;
        for (const p of peers) {
          const isMe = p.id === peer.id;
          msg += `  ${isMe ? "→" : " "} ${p.role} (${p.id})${isMe ? " ← YOU" : ""}\n`;
        }

        msg += "\n── LISTEN FOR EVENTS (zero tokens) ──";
        msg += "\nRun this in bash to watch for commands, signals, and messages without burning tokens:";
        msg += `\n\n  curl -sN "${baseUrl}/events"`;
        msg += `\n\nYour peer ID is: ${peer.id}`;
        msg += `\nYour role is: ${peer.role}`;
        msg += "\n\nWhen you see an event with your peer ID or role as the target, act on it.";
        msg += "\nIgnore events meant for other peers.";
        msg += "\nAfter executing a command, call ack_command() with the result.";
        msg += "\nYou can also send commands, messages, and signals to other peers using the MCP tools.";

        return { content: [{ type: "text", text: msg }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Connection failed: ${err.message}` }] };
      }
    }
  );

  // ── Tool: my_info ──
  mcp.tool(
    "my_info",
    "Get your peer ID, role, and connection status.",
    {},
    async (_args, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;
      const peerId = sid ? sessionPeers.get(sid) : null;
      if (!peerId) {
        return { content: [{ type: "text", text: "Not connected. Call connect() first." }] };
      }
      const peer = broker.getPeer(peerId);
      if (!peer) {
        return { content: [{ type: "text", text: `Peer ${peerId} no longer exists. Call connect() to reconnect.` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(peer, null, 2) }] };
    }
  );

  // ── Tool: list_peers ──
  mcp.tool(
    "list_peers",
    "List all registered peers and their roles. See who's online.",
    {},
    async () => {
      const peers = broker.listPeers();
      return {
        content: [
          {
            type: "text",
            text: peers.length === 0
              ? "No peers registered."
              : JSON.stringify(peers, null, 2),
          },
        ],
      };
    }
  );

  // ── Tool: send_command ──
  mcp.tool(
    "send_command",
    "Send a command to another peer by role name or peer ID. The target will receive it when they call wait_for_command(). Use this to coordinate work between sessions.",
    {
      target: z.string().describe("Target peer role (e.g. 'linux-client') or peer ID"),
      action: z.string().describe("Command action (e.g. 'start_server', 'run_test', 'connect_and_handshake')"),
      params: z
        .string()
        .optional()
        .describe("Optional JSON params for the command"),
    },
    async ({ target, action, params }, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;
      const fromId = (sid ? sessionPeers.get(sid) : null) || "unknown";

      let parsedParams = null;
      if (params) {
        try { parsedParams = JSON.parse(params); } catch { parsedParams = params; }
      }

      try {
        const cmds = broker.sendCommand(fromId, target, action, parsedParams);
        return {
          content: [
            {
              type: "text",
              text: `Command '${action}' sent to ${cmds.length} peer(s):\n${JSON.stringify(cmds, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
      }
    }
  );

  // ── Tool: wait_for_command ──
  mcp.tool(
    "wait_for_command",
    `Wait for a command. NOTE: This tool burns tokens while waiting!

PREFERRED: Use bash curl instead for zero-token waiting:
  curl -sN "${baseUrl}/commands/<YOUR_PEER_ID>/wait?timeout=300000"
Call my_info() to get your peer ID. Only use this MCP tool for short waits.`,
    {
      timeout_seconds: z
        .number()
        .optional()
        .default(60)
        .describe("Max seconds to wait (default 60)"),
    },
    async ({ timeout_seconds }, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;
      const peerId = sid ? sessionPeers.get(sid) : null;
      if (!peerId) {
        return { content: [{ type: "text", text: `Not registered. Call connect() first.` }] };
      }

      const cmd = await broker.waitForCommand(peerId, timeout_seconds * 1000);
      if (cmd) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { received: true, command_id: cmd.id, from: cmd.from, action: cmd.action, params: cmd.params },
                null,
                2
              ),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ received: false, error: "timeout" }) }] };
    }
  );

  // ── Tool: ack_command ──
  mcp.tool(
    "ack_command",
    "Acknowledge a command after executing it. Send back the result so the orchestrator knows you're done.",
    {
      command_id: z.number().describe("The command ID to acknowledge"),
      result: z
        .string()
        .optional()
        .describe("Result data (text or JSON string)"),
    },
    async ({ command_id, result }) => {
      let parsedResult = null;
      if (result) {
        try { parsedResult = JSON.parse(result); } catch { parsedResult = result; }
      }

      const cmd = broker.ackCommand(command_id, parsedResult);
      if (cmd) {
        return { content: [{ type: "text", text: `Command ${command_id} acknowledged.\n${JSON.stringify(cmd, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: `Command ${command_id} not found.` }] };
    }
  );

  // ── Tool: send_message ──
  mcp.tool(
    "send_message",
    "Send a message to a named channel. Messages include your identity if registered.",
    {
      channel: z.string().describe("Channel name (e.g. 'test-results', 'commands')"),
      message: z.string().describe("Message content (text or JSON string)"),
    },
    async ({ channel, message }, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;
      const fromId = sid ? sessionPeers.get(sid) : null;

      let data;
      try { data = JSON.parse(message); } catch { data = message; }
      const entry = broker.send(channel, data, fromId);
      return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
    }
  );

  // ── Tool: read_messages ──
  mcp.tool(
    "read_messages",
    "Read messages from a channel. Use since_id to get only new messages since your last read.",
    {
      channel: z.string().describe("Channel name to read from"),
      since_id: z.number().optional().default(0).describe("Only return messages with ID greater than this"),
    },
    async ({ channel, since_id }) => {
      const messages = broker.read(channel, since_id);
      return {
        content: [
          { type: "text", text: JSON.stringify({ channel, count: messages.length, messages }, null, 2) },
        ],
      };
    }
  );

  // ── Tool: signal ──
  mcp.tool(
    "signal",
    "Emit a named signal. Signals include your identity if registered. Any instance waiting for this signal will be notified immediately.",
    {
      name: z.string().describe("Signal name (e.g. 'server_ready', 'handshake_done')"),
      data: z.string().optional().describe("Optional data (text or JSON string)"),
    },
    async ({ name, data }, extra) => {
      const sid = extra?.sessionId || extra?._meta?.sessionId;
      const fromId = sid ? sessionPeers.get(sid) : null;

      let parsed = null;
      if (data) {
        try { parsed = JSON.parse(data); } catch { parsed = data; }
      }
      const entry = broker.signal(name, parsed, fromId);
      return { content: [{ type: "text", text: `Signal '${name}' emitted at ${entry.ts}` }] };
    }
  );

  // ── Tool: wait_for_signal ──
  mcp.tool(
    "wait_for_signal",
    "Wait for a named signal. Returns immediately if already emitted.",
    {
      name: z.string().describe("Signal name to wait for"),
      timeout_seconds: z.number().optional().default(30).describe("Max seconds to wait (default 30)"),
    },
    async ({ name, timeout_seconds }) => {
      const result = await broker.waitForSignal(name, timeout_seconds * 1000);
      if (result) {
        return {
          content: [{ type: "text", text: JSON.stringify({ received: true, signal: name, ...result }, null, 2) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ received: false, signal: name, error: "timeout" }) }],
      };
    }
  );

  // ── Tool: list_channels ──
  mcp.tool("list_channels", "List all active channels and their message counts.", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(broker.listChannels(), null, 2) }] };
  });

  // ── Tool: broker_status ──
  mcp.tool(
    "broker_status",
    "Get full broker status: peers, channels, signals, pending commands.",
    {},
    async () => {
      return { content: [{ type: "text", text: JSON.stringify(broker.status(), null, 2) }] };
    }
  );

  // ── Tool: reset_broker ──
  mcp.tool(
    "reset_broker",
    "Clear all state: peers, channels, signals, commands. Use between test runs.",
    {},
    async () => {
      broker.reset();
      sessionPeers.clear();
      return { content: [{ type: "text", text: "Broker reset. All state cleared." }] };
    }
  );

}

/**
 * Mount SSE MCP transport onto an Express app.
 * Creates a fresh McpServer per SSE connection to support multiple clients.
 */
function mountMcp(app, broker, baseUrl) {
  const transports = new Map();
  const mcpServers = new Map();
  // Shared across all connections so peers persist
  const sessionPeers = new Map();

  app.get("/mcp/sse", async (req, res) => {
    const mcp = new McpServer({ name: "ipcb", version: "2.0.0" });
    registerTools(mcp, broker, sessionPeers, baseUrl);

    const transport = new SSEServerTransport("/mcp/messages", res);
    transports.set(transport.sessionId, transport);
    mcpServers.set(transport.sessionId, mcp);

    res.on("close", () => {
      sessionPeers.delete(transport.sessionId);
      transports.delete(transport.sessionId);
      mcpServers.delete(transport.sessionId);
    });
    await mcp.connect(transport);
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown or expired session", code: "SESSION_NOT_FOUND" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  return transports;
}

module.exports = { mountMcp };
