const { EventEmitter } = require("events");
const crypto = require("crypto");

/**
 * In-memory message broker.
 * Manages channels, signals, peer registry, and command inbox.
 * Emits 'activity' events for real-time dashboard updates.
 */
class Broker extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Array<{id: number, ts: string, from: {id:string,role:string}|null, data: any}>>} */
    this.channels = new Map();

    /** @type {Map<string, {ts: string, data: any}>} */
    this.signals = new Map();

    /** @type {Map<string, Array<{resolve: Function, timer: NodeJS.Timeout}>>} */
    this.signalWaiters = new Map();

    /** @type {Map<string, {id: string, role: string, capabilities: string[], joinedAt: string, lastSeen: string, status: string}>} */
    this.peers = new Map();

    /** @type {Map<string, Array<{id: number, from: string, target: string, action: string, params: any, ts: string, status: string, result: any|null, ackedAt: string|null}>>} */
    this.commands = new Map();

    /** @type {Map<string, Array<{resolve: Function, timer: NodeJS.Timeout}>>} */
    this.commandWaiters = new Map();

    this._nextId = 1;
    this._nextCmdId = 1;
  }

  // ── Peers ──

  registerPeer(role, capabilities = []) {
    // Only one orchestrator at a time
    if (role === "orchestrator") {
      for (const peer of this.peers.values()) {
        if (peer.role === "orchestrator") {
          throw new Error(`Orchestrator already registered: ${peer.id} (${peer.role})`);
        }
      }
    }

    const id = role.slice(0, 3) + "-" + crypto.randomBytes(3).toString("hex");
    const now = new Date().toISOString();
    const peer = { id, role, capabilities, joinedAt: now, lastSeen: now, status: "online" };
    this.peers.set(id, peer);
    this.commands.set(id, []);
    this.emit("activity", { type: "peer_join", peer });

    // Auto-signal: peer is ready
    this.signal(`${role}_ready`, { peerId: id, role, capabilities }, id);
    // Auto-log to activity channel
    this.send("activity", { event: "peer_joined", role, peerId: id, capabilities }, id);

    return peer;
  }

  unregisterPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return false;
    peer.status = "offline";
    this.peers.delete(id);

    // Wake any command waiters for this peer
    const waiters = this.commandWaiters.get(id) || [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.commandWaiters.delete(id);

    this.emit("activity", { type: "peer_leave", peer });
    return true;
  }

  heartbeat(id) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    peer.lastSeen = new Date().toISOString();
    peer.status = "online";
    return peer;
  }

  setRole(id, role, capabilities) {
    const peer = this.peers.get(id);
    if (!peer) return null;
    peer.role = role;
    if (capabilities !== undefined) peer.capabilities = capabilities;
    this.emit("activity", { type: "peer_updated", peer });
    return peer;
  }

  listPeers() {
    return [...this.peers.values()];
  }

  getPeer(id) {
    return this.peers.get(id) || null;
  }

  /** Find all peers matching a target (peer ID, role name, or "*"/"all" for broadcast) */
  _resolvePeerTargets(target, excludeId) {
    // Broadcast to all peers
    if (target === "*" || target === "all") {
      return [...this.peers.keys()].filter((id) => id !== excludeId);
    }
    // Direct peer ID match
    if (this.peers.has(target)) return [target];
    // Match by role
    const matches = [];
    for (const peer of this.peers.values()) {
      if (peer.role === target) matches.push(peer.id);
    }
    return matches;
  }

  // ── Commands ──

  sendCommand(fromId, target, action, params = null) {
    const targets = this._resolvePeerTargets(target, fromId);
    if (targets.length === 0) {
      throw new Error(`No peer found matching target: ${target}`);
    }

    const fromPeer = fromId === "human" ? { id: "human", role: "human" } : this.peers.get(fromId);
    const sent = [];

    for (const peerId of targets) {
      const cmd = {
        id: this._nextCmdId++,
        from: fromPeer ? fromPeer.role : fromId,
        fromId: fromPeer ? fromPeer.id : fromId,
        target: peerId,
        targetRole: this.peers.get(peerId)?.role || peerId,
        action,
        params,
        ts: new Date().toISOString(),
        status: "pending",
        result: null,
        ackedAt: null,
      };

      if (!this.commands.has(peerId)) this.commands.set(peerId, []);
      this.commands.get(peerId).push(cmd);
      sent.push(cmd);

      // Wake any command waiters for this peer
      const waiters = this.commandWaiters.get(peerId) || [];
      if (waiters.length > 0) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        cmd.delivered = true;
        w.resolve(cmd);
        if (waiters.length === 0) this.commandWaiters.delete(peerId);
      }
    }

    this.emit("activity", { type: "command_sent", commands: sent });
    return sent;
  }

  getCommands(peerId, sinceId = 0) {
    const cmds = this.commands.get(peerId) || [];
    return cmds.filter((c) => c.id > sinceId);
  }

  waitForCommand(peerId, timeoutMs = 30000) {
    // Check for any pending commands first
    const cmds = this.commands.get(peerId) || [];
    const pending = cmds.find((c) => c.status === "pending" && !c.delivered);
    if (pending) {
      pending.delivered = true;
      return Promise.resolve(pending);
    }

    if (timeoutMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.commandWaiters.get(peerId) || [];
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      if (!this.commandWaiters.has(peerId)) this.commandWaiters.set(peerId, []);
      this.commandWaiters.get(peerId).push({ resolve, timer });
    });
  }

  ackCommand(commandId, result = null) {
    // Search all command inboxes for this command ID
    for (const cmds of this.commands.values()) {
      const cmd = cmds.find((c) => c.id === commandId);
      if (cmd) {
        cmd.status = "acked";
        cmd.result = result;
        cmd.ackedAt = new Date().toISOString();
        this.emit("activity", { type: "command_ack", command: cmd });

        // Auto-signal: action done
        this.signal(`${cmd.action}_done`, { commandId: cmd.id, by: cmd.targetRole, result }, cmd.target);
        // Auto-log to activity channel
        this.send("activity", { event: "command_completed", action: cmd.action, by: cmd.targetRole, for: cmd.from, result }, cmd.target);

        // Send response back to the original sender so they get notified
        if (cmd.fromId && cmd.fromId !== "human" && cmd.fromId !== "unknown" && this.peers.has(cmd.fromId)) {
          const response = {
            id: this._nextCmdId++,
            from: cmd.targetRole,
            fromId: cmd.target,
            target: cmd.fromId,
            targetRole: cmd.from,
            action: "command_response",
            params: { original_command_id: cmd.id, original_action: cmd.action, result },
            ts: new Date().toISOString(),
            status: "pending",
            result: null,
            ackedAt: null,
          };

          if (!this.commands.has(cmd.fromId)) this.commands.set(cmd.fromId, []);
          this.commands.get(cmd.fromId).push(response);

          // Wake any waiters on the original sender
          const waiters = this.commandWaiters.get(cmd.fromId) || [];
          if (waiters.length > 0) {
            const w = waiters.shift();
            clearTimeout(w.timer);
            response.delivered = true;
            w.resolve(response);
            if (waiters.length === 0) this.commandWaiters.delete(cmd.fromId);
          }

          this.emit("activity", { type: "command_sent", commands: [response] });
        }

        return cmd;
      }
    }
    return null;
  }

  getAllCommands() {
    const all = [];
    for (const cmds of this.commands.values()) {
      all.push(...cmds);
    }
    return all.sort((a, b) => b.id - a.id);
  }

  // ── Channels (ordered message streams) ──

  send(channel, message, fromPeerId = null) {
    if (!this.channels.has(channel)) this.channels.set(channel, []);
    const fromPeer = fromPeerId ? this.peers.get(fromPeerId) : null;
    const entry = {
      id: this._nextId++,
      ts: new Date().toISOString(),
      from: fromPeer ? { id: fromPeer.id, role: fromPeer.role } : null,
      data: message,
    };
    this.channels.get(channel).push(entry);
    this.emit("activity", { type: "message", channel, entry });
    return entry;
  }

  read(channel, sinceId = 0) {
    const msgs = this.channels.get(channel) || [];
    return msgs.filter((m) => m.id > sinceId);
  }

  listChannels() {
    const result = {};
    for (const [name, msgs] of this.channels) {
      result[name] = { count: msgs.length, lastId: msgs.length ? msgs[msgs.length - 1].id : 0 };
    }
    return result;
  }

  // ── Signals (one-shot named events with optional wait) ──

  signal(name, data = null, fromPeerId = null) {
    const fromPeer = fromPeerId ? this.peers.get(fromPeerId) : null;
    const entry = {
      ts: new Date().toISOString(),
      data,
      from: fromPeer ? { id: fromPeer.id, role: fromPeer.role } : null,
    };
    this.signals.set(name, entry);

    // Wake anyone waiting for this signal
    const waiters = this.signalWaiters.get(name) || [];
    const waiterCount = waiters.length;
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(entry);
    }
    this.signalWaiters.delete(name);

    this.emit("activity", { type: "signal", name, entry, woke: waiterCount });
    return entry;
  }

  waitForSignal(name, timeoutMs = 30000) {
    if (this.signals.has(name)) {
      return Promise.resolve(this.signals.get(name));
    }

    if (timeoutMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.signalWaiters.get(name) || [];
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      if (!this.signalWaiters.has(name)) this.signalWaiters.set(name, []);
      this.signalWaiters.get(name).push({ resolve, timer });
    });
  }

  clearSignal(name) {
    this.signals.delete(name);
  }

  listSignals() {
    const result = {};
    for (const [name, entry] of this.signals) {
      result[name] = entry;
    }
    return result;
  }

  // ── Status ──

  status() {
    return {
      peers: this.listPeers(),
      channels: this.listChannels(),
      signals: this.listSignals(),
      pendingWaiters: Object.fromEntries(
        [...this.signalWaiters.entries()].map(([k, v]) => [k, v.length])
      ),
      pendingCommands: this.getAllCommands().filter((c) => c.status === "pending").length,
    };
  }

  reset() {
    this.channels.clear();
    this.signals.clear();
    this.peers.clear();
    this.commands.clear();
    for (const waiters of this.signalWaiters.values()) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
    this.signalWaiters.clear();
    for (const waiters of this.commandWaiters.values()) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
    this.commandWaiters.clear();
    this._nextId = 1;
    this._nextCmdId = 1;
    this.emit("activity", { type: "reset" });
  }
}

module.exports = { Broker };
