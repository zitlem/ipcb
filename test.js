#!/usr/bin/env node
/**
 * Smoke tests for ipcb.
 * Tests peers, commands, channels, signals.
 */
const http = require("http");
const { Broker } = require("./broker");
const { createHttpApi } = require("./http-api");

const broker = new Broker();
const app = createHttpApi(broker);
let server;
let passed = 0;
let failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1", port: 9199, path, method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, condition) {
  if (condition) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}`); failed++; }
}

async function run() {
  server = app.listen(9199, "127.0.0.1");
  console.log("\nRunning tests...\n");

  // ═══ DISCOVERY ═══
  console.log("── Discovery ──");

  const disc1 = await request("GET", "/peers/discover");
  assert("discovery returns empty peers", disc1.body.ok && disc1.body.peers.length === 0);
  assert("discovery shows no orchestrator", disc1.body.hasOrchestrator === false);
  assert("discovery has suggestions", disc1.body.suggestions.length > 0);

  // ═══ PEERS ═══
  console.log("\n── Peers ──");

  const reg1 = await request("POST", "/peers/connect", { role: "orchestrator", capabilities: ["coordinate"] });
  assert("connect orchestrator", reg1.body.ok && reg1.body.peer.role === "orchestrator");
  assert("connect returns allPeers", Array.isArray(reg1.body.allPeers));
  const orchId = reg1.body.peer.id;

  // Discovery after first peer
  const disc2 = await request("GET", "/peers/discover");
  assert("discovery shows 1 peer after connect", disc2.body.peers.length === 1);
  assert("discovery shows orchestrator exists", disc2.body.hasOrchestrator === true);

  const reg2 = await request("POST", "/peers/connect", { role: "linux-client", capabilities: ["airshow", "network"] });
  assert("connect linux-client", reg2.body.ok && reg2.body.peer.role === "linux-client");
  const linuxId = reg2.body.peer.id;

  const reg3 = await request("POST", "/peers/register", { role: "backend", capabilities: ["tcp"] });
  assert("register backend (legacy endpoint)", reg3.body.ok && reg3.body.peer.role === "backend");
  const backendId = reg3.body.peer.id;

  // Only one orchestrator
  const reg4 = await request("POST", "/peers/connect", { role: "orchestrator" });
  assert("reject second orchestrator", reg4.status === 409);

  // List peers
  const peers = await request("GET", "/peers");
  assert("list peers returns 3", peers.body.peers.length === 3);

  // Heartbeat
  const hb = await request("POST", `/peers/${linuxId}/heartbeat`);
  assert("heartbeat updates lastSeen", hb.body.ok && hb.body.peer.id === linuxId);

  // Unregister
  const unreg = await request("DELETE", `/peers/${backendId}`);
  assert("unregister backend", unreg.body.ok);
  const peersAfter = await request("GET", "/peers");
  assert("after unregister, 2 peers remain", peersAfter.body.peers.length === 2);

  // Re-register backend for command tests
  const reg5 = await request("POST", "/peers/register", { role: "backend", capabilities: ["tcp"] });
  const backendId2 = reg5.body.peer.id;

  // ═══ COMMANDS ═══
  console.log("\n── Commands ──");

  // Send command by role
  const cmd1 = await request("POST", "/commands/send", {
    from: "human", target: "linux-client", action: "start_test", params: { suite: "handshake" }
  });
  assert("send command to linux-client", cmd1.body.ok && cmd1.body.commands.length === 1);
  const cmdId = cmd1.body.commands[0].id;
  assert("command has correct action", cmd1.body.commands[0].action === "start_test");
  assert("command from is human", cmd1.body.commands[0].from === "human");

  // Get commands for linux-client
  const cmds = await request("GET", `/commands/${linuxId}`);
  assert("get commands returns 1", cmds.body.commands.length === 1);
  assert("command is pending", cmds.body.commands[0].status === "pending");

  // Ack command
  const ack = await request("POST", `/commands/${cmdId}/ack`, { result: { status: "pass", frames: 42 } });
  assert("ack command succeeds", ack.body.ok);
  assert("ack status is acked", ack.body.command.status === "acked");
  assert("ack result matches", ack.body.command.result.frames === 42);

  // Send command from orchestrator to backend by role
  const cmd2 = await request("POST", "/commands/send", {
    from: orchId, target: "backend", action: "start_server", params: { port: 7400 }
  });
  assert("orchestrator sends to backend", cmd2.body.ok);
  assert("command from is orchestrator role", cmd2.body.commands[0].from === "orchestrator");

  // Command wait (already has pending command)
  const wait1 = await request("GET", `/commands/${backendId2}/wait?timeout=1000`);
  assert("wait returns pending command immediately", wait1.body.ok && wait1.body.command.action === "start_server");

  // Command wait with timeout (no pending)
  await request("POST", `/commands/${wait1.body.command.id}/ack`, { result: "ok" });
  const start = Date.now();
  const wait2 = await request("GET", `/commands/${backendId2}/wait?timeout=500`);
  const elapsed = Date.now() - start;
  assert("wait timeout returns 408", wait2.status === 408);
  assert("wait actually waited (~500ms)", elapsed >= 400 && elapsed < 2000);

  // Concurrent wait + send
  const waitPromise = request("GET", `/commands/${linuxId}/wait?timeout=5000`);
  await new Promise(r => setTimeout(r, 50));
  await request("POST", "/commands/send", {
    from: "human", target: "linux-client", action: "connect", params: { ip: "192.168.1.10" }
  });
  const waitResult = await waitPromise;
  assert("concurrent wait receives command", waitResult.body.ok && waitResult.body.command.action === "connect");

  // Unknown target
  const cmd3 = await request("POST", "/commands/send", {
    from: "human", target: "nonexistent", action: "noop"
  });
  assert("unknown target returns 404", cmd3.status === 404);

  // All commands
  const allCmds = await request("GET", "/commands");
  assert("list all commands returns 3+", allCmds.body.commands.length >= 3);

  // ═══ CHANNELS (with identity) ═══
  console.log("\n── Channels (with identity) ──");

  const send1 = await request("POST", `/channels/test/send?from=${linuxId}`, { hello: "world" });
  assert("send message with peer identity", send1.body.ok && send1.body.entry.from !== null);
  assert("message from role is linux-client", send1.body.entry.from.role === "linux-client");

  const send2 = await request("POST", "/channels/test/send", { anon: true });
  assert("anonymous message has null from", send2.body.ok && send2.body.entry.from === null);

  const read1 = await request("GET", "/channels/test/messages");
  assert("read messages returns 2", read1.body.messages.length === 2);

  const chans = await request("GET", "/channels");
  assert("list channels shows test", chans.body.channels.test !== undefined);

  // ═══ SIGNALS (with identity) ═══
  console.log("\n── Signals (with identity) ──");

  const sig1 = await request("POST", `/signals/ready?from=${orchId}`, { data: { port: 7400 } });
  assert("signal with identity", sig1.body.ok);

  const check = await request("GET", "/signals/ready");
  assert("signal has from field", check.body.from !== null && check.body.from.role === "orchestrator");

  const miss = await request("GET", "/signals/nonexistent");
  assert("missing signal returns 404", miss.status === 404);

  // Signal wait
  const sigWait = await request("GET", "/signals/ready/wait?timeout=1000");
  assert("wait for existing signal returns immediately", sigWait.body.ok);

  // Signal wait timeout
  const sigStart = Date.now();
  const sigWait2 = await request("GET", "/signals/nope/wait?timeout=500");
  const sigElapsed = Date.now() - sigStart;
  assert("signal wait timeout returns 408", sigWait2.status === 408);
  assert("signal wait actually waited", sigElapsed >= 400 && sigElapsed < 2000);

  // ═══ STATUS ═══
  console.log("\n── Status ──");

  const status = await request("GET", "/status");
  assert("status includes peers", Array.isArray(status.body.peers));
  assert("status includes pendingCommands", typeof status.body.pendingCommands === "number");

  // ═══ RESET ═══
  console.log("\n── Reset ──");

  const reset = await request("POST", "/reset");
  assert("reset returns ok", reset.body.ok);
  const afterReset = await request("GET", "/status");
  assert("after reset peers empty", afterReset.body.peers.length === 0);
  assert("after reset channels empty", Object.keys(afterReset.body.channels).length === 0);

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
