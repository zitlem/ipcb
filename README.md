# ipcb

A message broker that lets multiple terminals talk to each other. Includes a real-time web dashboard where you can watch and send commands to any connected session.

Works with any process that speaks HTTP or MCP — AI chatbots, scripts, services. Works across terminals on the same machine or across different PCs on a network.

## What it does

- **Peer registry** -- each session registers with a role (e.g. "backend", "linux-client") so everyone knows who's who
- **Command system** -- send orders to specific sessions by role, they execute and report back
- **Channels** -- named message streams for broadcasting data between sessions
- **Signals** -- one-shot events with wait/notify for coordination timing
- **Web dashboard** -- real-time UI showing all peers, messages, commands, and activity
- **Dual authority** -- both an orchestrator AND a human from the dashboard can give orders

## Install

Two steps: start the broker, then add the MCP server.

### Step 1: Start the broker

Pick any option:

**npx (no install needed):**
```bash
npx github:zitlem/ipcb
```

To update to the latest version (npx caches the package):
```bash
npx clear-npx-cache && npx github:zitlem/ipcb
```

**Global install:**
```bash
npm install -g github:zitlem/ipcb
ipcb
```

**Clone:**
```bash
git clone https://github.com/zitlem/ipcb.git
cd ipcb && npm install && node index.js
```

Runs on `http://0.0.0.0:9100` by default. Change with flags:

```bash
ipcb --port 8080 --host 127.0.0.1
```

Dashboard opens at `http://localhost:9100/dashboard`.

### Step 2: Add the MCP server

Any MCP-compatible client can connect. Example with Claude Code:

**Same machine:**
```bash
claude mcp add --transport sse ipcb http://localhost:9100/mcp/sse
```

**Cross-PC** (point to the machine running the broker):
```bash
claude mcp add --transport sse ipcb http://192.168.1.100:9100/mcp/sse
```

**Global** (available in all projects):
```bash
claude mcp add --transport sse --scope global ipcb http://localhost:9100/mcp/sse
```

Run `mcp add` on **every machine/terminal** that needs to connect.

### Verify

Open a terminal with MCP configured and say:

> "Connect to the IPC broker"

The client will automatically discover who's online and ask what role this session should play.

## Usage

### Quick start -- just talk naturally

Once the MCP is configured, you don't need to remember any tool names. Just say what you want in plain English:

| You say | What happens |
|---------|------------|
| "Connect to the IPC broker" | Calls `connect()`, shows who's online, asks your role |
| "Who else is online?" | Calls `list_peers()` |
| "Tell the backend to start the server" | Calls `send_command("backend", "start_server")` |
| "Wait for a command" | Calls `wait_for_command()` |
| "Signal that the server is ready" | Calls `signal("server_ready")` |
| "Wait until the server is ready" | Calls `wait_for_signal("server_ready")` |

### MCP tools reference

These tools are available when connected via MCP:

| Tool | Purpose |
|------|---------|
| `connect()` | Discover peers + register this session |
| `connect(role, capabilities)` | Register with a specific role |
| `my_info()` | Show this session's ID and role |
| `list_peers()` | See who's online |
| `send_command(target, action, params)` | Send an order to a peer by role |
| `wait_for_command(timeout)` | Block until a command arrives |
| `ack_command(id, result)` | Report command completion |
| `send_message(channel, message)` | Post to a message channel |
| `read_messages(channel, since_id)` | Read from a channel |
| `signal(name, data)` | Emit a named event |
| `wait_for_signal(name, timeout)` | Block until an event fires |
| `broker_status()` | Full broker state |
| `reset_broker()` | Clear everything |

### HTTP API reference

Everything available via MCP is also available with curl or any HTTP client.

**Peers:**
```bash
# Discover who's online
curl http://localhost:9100/peers/discover

# Register
curl -X POST http://localhost:9100/peers/connect \
  -H 'Content-Type: application/json' \
  -d '{"role":"backend","capabilities":["tcp","server"]}'

# List all
curl http://localhost:9100/peers
```

**Commands:**
```bash
# Send a command (as the human)
curl -X POST http://localhost:9100/commands/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"human","target":"backend","action":"start_server","params":{"port":7400}}'

# Check commands for a peer
curl http://localhost:9100/commands/<peer-id>

# Wait for a command (long-poll)
curl http://localhost:9100/commands/<peer-id>/wait?timeout=30000

# Acknowledge
curl -X POST http://localhost:9100/commands/<command-id>/ack \
  -H 'Content-Type: application/json' \
  -d '{"result":{"status":"ok"}}'
```

**Channels:**
```bash
# Send message
curl -X POST http://localhost:9100/channels/results/send \
  -H 'Content-Type: application/json' \
  -d '{"test":"handshake","status":"pass"}'

# Read messages
curl http://localhost:9100/channels/results/messages

# Read only new messages
curl http://localhost:9100/channels/results/messages?since=5
```

**Signals:**
```bash
# Emit
curl -X POST http://localhost:9100/signals/server_ready \
  -H 'Content-Type: application/json' \
  -d '{"data":{"port":7400}}'

# Wait (long-poll)
curl http://localhost:9100/signals/server_ready/wait?timeout=30000

# Check without waiting
curl http://localhost:9100/signals/server_ready
```

**System:**
```bash
curl http://localhost:9100/status    # Full state
curl -X POST http://localhost:9100/reset  # Clear everything
```

### Dashboard

The web dashboard at `http://localhost:9100/dashboard` shows:

- **Peers** -- who's connected, their roles and capabilities
- **Channels** -- message streams (click to inspect)
- **Signals** -- emitted events with data
- **Live Activity** -- real-time feed of everything happening
- **Command Center** -- send commands to any peer, see pending/acked status

The dashboard updates in real-time via Server-Sent Events. No polling, no refresh needed.

## Example: 4-session cross-platform test

```
Terminal 1 (start broker):
  $ npx github:zitlem/ipcb

Terminal 2 (orchestrator):
  > "Connect to the IPC broker as the orchestrator"

Terminal 3 (linux client):
  > "Connect to the IPC broker"
  Asks: "What role?" -> "linux-client"

Terminal 4 (backend server):
  > "Connect to the IPC broker"
  Asks: "What role?" -> "backend"

Dashboard (browser):
  Open http://localhost:9100/dashboard
  Select target: "backend"
  Action: "start_server"
  Params: {"port": 7400}
  Click Send

  -> Backend receives the command, starts the server, acks.

  Select target: "linux-client"
  Action: "connect_and_test"
  Params: {"ip": "localhost", "port": 7400}
  Click Send

  -> Linux client connects, runs test, acks with results.

  All activity visible in real-time on the dashboard.
```

## Architecture

```
                    +---------------------------+
                    |      BROKER (Node.js)     |
                    |                           |
                    |  Peers    - registry      |
                    |  Commands - per-peer inbox |
                    |  Channels - msg streams   |
                    |  Signals  - one-shot      |
                    +----------+----------------+
                               |
          +--------------------+--------------------+
          |                    |                     |
   +------+------+     +------+------+      +-------+------+
   | Session A   |     | Session B   |      |  Dashboard   |
   | MCP (SSE)   |     | MCP (SSE)   |      |  Browser     |
   | orchestrator|     | linux-client|      |  human ctrl  |
   +-------------+     +-------------+      +--------------+
```

The broker runs as a standalone HTTP server. Clients connect via MCP (SSE transport) or plain HTTP. The dashboard connects via Server-Sent Events. Commands, messages, and signals all flow through the broker.

## Tests

```bash
npm test
```

Runs 46 tests covering peers, discovery, commands, channels, signals, and reset.

## License

MIT
