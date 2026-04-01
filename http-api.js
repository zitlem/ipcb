/**
 * HTTP REST API layer over the broker.
 * Works with curl, fetch, any HTTP client.
 */
const express = require("express");
const path = require("path");

function createHttpApi(broker) {
  const app = express();
  app.use(express.json());

  // ── Dashboard ──
  app.get("/dashboard", (_req, res) => {
    res.sendFile("dashboard.html", { root: __dirname });
  });

  // ── Real-time SSE event stream for dashboard ──
  app.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send current state as first event
    res.write(`data: ${JSON.stringify({ type: "snapshot", ...broker.status() })}\n\n`);

    const onActivity = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    broker.on("activity", onActivity);

    req.on("close", () => {
      broker.off("activity", onActivity);
    });
  });

  // ── Peers ──

  // Discovery — see who's online before registering
  app.get("/peers/discover", (_req, res) => {
    const peers = broker.listPeers();
    const hasOrchestrator = peers.some((p) => p.role === "orchestrator");
    const pending = broker.getAllCommands().filter((c) => c.status === "pending").length;
    res.json({
      ok: true,
      peers,
      hasOrchestrator,
      pendingCommands: pending,
      suggestions: peers.length === 0
        ? ["This is the first connection. Consider registering as 'orchestrator'."]
        : [`${peers.length} peer(s) online. Roles taken: ${peers.map(p => p.role).join(", ")}`],
    });
  });

  // Register (also available as /peers/connect for clarity)
  app.post("/peers/register", registerHandler);
  app.post("/peers/connect", registerHandler);

  function registerHandler(req, res) {
    const { role, capabilities } = req.body;
    if (!role) return res.status(400).json({ ok: false, error: "role is required" });
    try {
      const peer = broker.registerPeer(role, capabilities || []);
      res.json({ ok: true, peer, allPeers: broker.listPeers() });
    } catch (err) {
      res.status(409).json({ ok: false, error: err.message });
    }
  }

  app.delete("/peers/:id", (req, res) => {
    const removed = broker.unregisterPeer(req.params.id);
    if (removed) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: "peer not found" });
    }
  });

  app.post("/peers/:id/heartbeat", (req, res) => {
    const peer = broker.heartbeat(req.params.id);
    if (peer) {
      res.json({ ok: true, peer });
    } else {
      res.status(404).json({ ok: false, error: "peer not found" });
    }
  });

  app.get("/peers", (_req, res) => {
    res.json({ ok: true, peers: broker.listPeers() });
  });

  // ── Commands ──

  app.post("/commands/send", (req, res) => {
    const { from, target, action, params } = req.body;
    if (!target || !action) {
      return res.status(400).json({ ok: false, error: "target and action are required" });
    }
    try {
      const commands = broker.sendCommand(from || "human", target, action, params || null);
      res.json({ ok: true, commands });
    } catch (err) {
      res.status(404).json({ ok: false, error: err.message });
    }
  });

  app.get("/commands/:peerId", (req, res) => {
    const sinceId = parseInt(req.query.since || "0", 10);
    const commands = broker.getCommands(req.params.peerId, sinceId);
    res.json({ ok: true, peerId: req.params.peerId, commands });
  });

  app.get("/commands/:peerId/wait", async (req, res) => {
    const timeoutMs = parseInt(req.query.timeout || "30000", 10);
    const cmd = await broker.waitForCommand(req.params.peerId, timeoutMs);
    if (cmd) {
      res.json({ ok: true, command: cmd });
    } else {
      res.status(408).json({ ok: false, error: "timeout" });
    }
  });

  app.post("/commands/:id/ack", (req, res) => {
    const commandId = parseInt(req.params.id, 10);
    const cmd = broker.ackCommand(commandId, req.body.result ?? null);
    if (cmd) {
      res.json({ ok: true, command: cmd });
    } else {
      res.status(404).json({ ok: false, error: "command not found" });
    }
  });

  app.get("/commands", (_req, res) => {
    res.json({ ok: true, commands: broker.getAllCommands() });
  });

  // ── Channels ──

  app.post("/channels/:name/send", (req, res) => {
    const fromPeerId = req.query.from || null;
    const entry = broker.send(req.params.name, req.body, fromPeerId);
    res.json({ ok: true, entry });
  });

  app.get("/channels/:name/messages", (req, res) => {
    const sinceId = parseInt(req.query.since || "0", 10);
    const messages = broker.read(req.params.name, sinceId);
    res.json({ ok: true, channel: req.params.name, messages });
  });

  app.get("/channels", (_req, res) => {
    res.json({ ok: true, channels: broker.listChannels() });
  });

  // ── Signals ──

  app.post("/signals/:name", (req, res) => {
    const fromPeerId = req.query.from || null;
    const entry = broker.signal(req.params.name, req.body.data ?? null, fromPeerId);
    res.json({ ok: true, signal: req.params.name, entry });
  });

  app.get("/signals/:name/wait", async (req, res) => {
    const timeoutMs = parseInt(req.query.timeout || "30000", 10);
    const result = await broker.waitForSignal(req.params.name, timeoutMs);
    if (result) {
      res.json({ ok: true, signal: req.params.name, ...result });
    } else {
      res.status(408).json({ ok: false, error: "timeout", signal: req.params.name });
    }
  });

  app.get("/signals/:name", (req, res) => {
    const result = broker.waitForSignal(req.params.name, 0);
    result.then((r) => {
      if (r) {
        res.json({ ok: true, signal: req.params.name, ...r });
      } else {
        res.status(404).json({ ok: false, error: "not_found", signal: req.params.name });
      }
    });
  });

  app.delete("/signals/:name", (req, res) => {
    broker.clearSignal(req.params.name);
    res.json({ ok: true });
  });

  app.get("/signals", (_req, res) => {
    res.json({ ok: true, signals: broker.listSignals() });
  });

  // ── Status ──

  app.get("/status", (_req, res) => {
    res.json({ ok: true, ...broker.status() });
  });

  app.post("/reset", (_req, res) => {
    broker.reset();
    res.json({ ok: true, message: "Broker reset" });
  });

  return app;
}

module.exports = { createHttpApi };
