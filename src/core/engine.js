'use strict';
const crypto = require('crypto');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createIdentity, idFromPublicKey, clientHandshake, serverHandshake } = require('./channel');
const { Store } = require('./store');

const DEFAULT_UDP_PORT = 24250;
const DEFAULT_TCP_PORT = 24251;
const EVERYONE = 'everyone';
const MAX_TEXT = 64 * 1024;
const MAX_NAME = 64;
const MAX_PEERS = 5000;
const MAX_CONNECTIONS = 128;
const CHUNK_SIZE = 256 * 1024;
const IDLE_TIMEOUT_MS = 60000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

function cleanName(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) || 'Unknown';
}

// A sender controls this name, so it must never be able to choose a location.
function safeFileName(value) {
  let name = String(value ?? '').split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  return name.slice(0, 200) || 'file';
}

function uniquePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function broadcastAddresses() {
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      const toInt = (ip) => ip.split('.').reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0);
      const value = (toInt(entry.address) | ~toInt(entry.netmask)) >>> 0;
      addresses.add([24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.'));
    }
  }
  return [...addresses];
}

function parseTarget(target, defaultPort) {
  const [host, port] = String(target).trim().split(':');
  const parsedPort = port ? Number(port) : defaultPort;
  if (!net.isIPv4(host) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
  return { host, port: parsedPort };
}

class Engine extends EventEmitter {
  constructor(options) {
    super();
    this.store = new Store(options.dataDir);
    this.identity = this.store.loadOrCreateIdentity(createIdentity);
    this.id = idFromPublicKey(this.identity.publicKey);
    this.name = cleanName(options.name || os.userInfo().username);
    this.downloadDir = options.downloadDir;
    this.udpPort = options.udpPort ?? DEFAULT_UDP_PORT;
    this.tcpPort = options.tcpPort ?? DEFAULT_TCP_PORT;
    this.targets = options.targets || [];
    this.heartbeatMs = options.heartbeatMs ?? 10000;
    this.peerTimeoutMs = options.peerTimeoutMs ?? 35000;
    this.peers = new Map();
    this.sending = new Set();
    this.seen = new Set();
    this.lastReply = new Map();
    this.connections = 0;
    for (const peer of Object.values(this.store.data.peers)) {
      this.peers.set(peer.id, { ...peer, online: false, ip: null, tcpPort: null, lastSeen: 0 });
    }
    for (const message of this.store.allMessages()) {
      if (message.dir === 'in') this.seen.add(`${message.from}:${message.id}`);
      if (message.file && ['receiving', 'sending'].includes(message.file.state)) message.file.state = 'offered';
    }
  }

  async start() {
    await this.startTcp();
    await this.startUdp();
    this.announce('hello');
    this.heartbeat = setInterval(() => {
      this.announce('hello');
      this.expirePeers();
      this.flushOutbox();
    }, this.heartbeatMs);
    // Not a reason to keep the process alive during tests or shutdown.
    this.heartbeat.unref();
  }

  async stop() {
    clearInterval(this.heartbeat);
    await new Promise((resolve) => {
      if (!this.udp) return resolve();
      const packet = this.packet('bye');
      const pending = this.destinations();
      let remaining = pending.length;
      const done = () => this.udp.close(() => resolve());
      if (!remaining) return done();
      for (const { host, port } of pending) {
        this.udp.send(packet, port, host, () => {
          remaining -= 1;
          if (!remaining) done();
        });
      }
    });
    await new Promise((resolve) => (this.tcp ? this.tcp.close(() => resolve()) : resolve()));
    this.store.flush();
  }

  // ---- Discovery ----

  startUdp() {
    return new Promise((resolve, reject) => {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp.once('error', reject);
      this.udp.on('message', (data, info) => this.onDiscovery(data, info));
      this.udp.bind(this.udpPort, () => {
        this.udp.removeListener('error', reject);
        this.udp.on('error', (err) => this.emit('warning', `Discovery: ${err.message}`));
        this.udp.setBroadcast(true);
        resolve();
      });
    });
  }

  packet(type) {
    return Buffer.from(JSON.stringify({ app: 'beacon', v: 1, t: type, id: this.id, name: this.name, tcp: this.listenPort }));
  }

  destinations() {
    const list = broadcastAddresses().map((host) => ({ host, port: this.udpPort }));
    list.push({ host: '255.255.255.255', port: this.udpPort });
    for (const target of this.targets) {
      const parsed = parseTarget(target, this.udpPort);
      if (parsed) list.push(parsed);
    }
    return list;
  }

  announce(type) {
    const packet = this.packet(type);
    for (const { host, port } of this.destinations()) {
      // Individual networks being down is normal on laptops.
      this.udp.send(packet, port, host, () => {});
    }
  }

  onDiscovery(data, info) {
    if (data.length > 1024) return;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.app !== 'beacon' || message.v !== 1 || !ID_PATTERN.test(message.id) || message.id === this.id) return;
    if (message.t === 'bye') {
      const peer = this.peers.get(message.id);
      if (peer && peer.ip === info.address) {
        peer.online = false;
        this.emit('peers');
      }
      return;
    }
    if (!Number.isInteger(message.tcp) || message.tcp < 1 || message.tcp > 65535) return;
    if (message.t === 'hello') {
      const now = Date.now();
      if (now - (this.lastReply.get(info.address) || 0) > 2000) {
        this.lastReply.set(info.address, now);
        this.udp.send(this.packet('here'), info.port, info.address, () => {});
      }
    } else if (message.t !== 'here') {
      return;
    }
    this.notePeer(message.id, cleanName(message.name), info.address, message.tcp);
  }

  notePeer(id, name, ip, tcpPort) {
    let peer = this.peers.get(id);
    if (!peer) {
      if (this.peers.size >= MAX_PEERS) return;
      peer = { id, name };
      this.peers.set(id, peer);
    }
    const cameOnline = !peer.online;
    const changed = cameOnline || peer.name !== name || peer.ip !== ip;
    Object.assign(peer, { name, ip, tcpPort, online: true, lastSeen: Date.now() });
    this.store.data.peers[id] = { id, name };
    this.store.save();
    if (changed) this.emit('peers');
    if (cameOnline) this.flushOutbox();
  }

  expirePeers() {
    const cutoff = Date.now() - this.peerTimeoutMs;
    let changed = false;
    for (const peer of this.peers.values()) {
      if (peer.online && peer.lastSeen < cutoff) {
        peer.online = false;
        changed = true;
      }
    }
    if (changed) this.emit('peers');
  }

  listPeers() {
    const nameCounts = {};
    for (const peer of this.peers.values()) nameCounts[peer.name] = (nameCounts[peer.name] || 0) + 1;
    return [...this.peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      ip: peer.ip,
      online: Boolean(peer.online),
      duplicateName: nameCounts[peer.name] > 1,
    }));
  }

  // ---- Connections ----

  startTcp() {
    const server = net.createServer((socket) => this.onConnection(socket));
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && this.tcpPort !== 0) {
          // Peers learn the port from discovery, so another port still works.
          server.listen(0, '0.0.0.0');
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.removeAllListeners('error');
        server.on('error', (err) => this.emit('warning', `Connection: ${err.message}`));
        this.tcp = server;
        this.listenPort = server.address().port;
        resolve();
      });
      server.listen(this.tcpPort, '0.0.0.0');
    });
  }

  async onConnection(socket) {
    if (this.connections >= MAX_CONNECTIONS) return socket.destroy();
    this.connections += 1;
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('close', () => {
      this.connections -= 1;
    });
    try {
      const channel = await serverHandshake(socket, this.identity, this.name);
      const request = await channel.recv();
      if (request.t === 'msg') await this.onMessage(channel, request);
      else if (request.t === 'offer') await this.onOffer(channel, request);
      else if (request.t === 'file-get') await this.onFileRequest(channel, request);
      else if (request.t === 'file-declined') this.onFileDeclined(channel, request);
      channel.close();
    } catch {
      // Remote input is untrusted. Dropping the connection is the whole response.
      socket.destroy();
    }
  }

  async connect(peer) {
    if (!peer.online || !peer.ip) throw new Error('peer offline');
    const socket = net.connect({ host: peer.ip, port: peer.tcpPort });
    socket.on('error', () => {});
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy(new Error('timed out')));
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('connection closed')));
    });
    try {
      return await clientHandshake(socket, this.identity, this.name, peer.id);
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  // ---- Messages ----

  newMessage(fields) {
    return {
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: this.id,
      fromName: this.name,
      dir: 'out',
      status: 'queued',
      ...fields,
    };
  }

  sendText(conv, rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new Error('Message is empty');
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('Message is too long');
    if (conv === EVERYONE) return this.sendToEveryone(text);
    if (!this.peers.has(conv)) throw new Error('Unknown user');
    const message = this.newMessage({ conv, kind: 'text', text });
    this.store.addMessage(message);
    this.emit('message', message);
    this.flushOutbox();
    return message;
  }

  sendToEveryone(text) {
    const recipients = [...this.peers.values()].filter((peer) => peer.online).map((peer) => peer.id);
    const message = this.newMessage({ conv: EVERYONE, kind: 'text', text, status: 'sent', recipients, pending: [...recipients] });
    this.store.addMessage(message);
    this.emit('message', message);
    this.flushOutbox();
    return message;
  }

  offerFile(conv, filePath) {
    if (conv === EVERYONE || !this.peers.has(conv)) throw new Error('Files can only be sent to one person');
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('Only files can be sent');
    const fileId = crypto.randomUUID();
    const name = safeFileName(path.basename(filePath));
    this.store.data.offers[fileId] = { path: filePath, to: conv };
    const message = this.newMessage({ conv, kind: 'file', file: { fileId, name, size: stat.size, state: 'offered' } });
    this.store.addMessage(message);
    this.emit('message', message);
    this.flushOutbox();
    return message;
  }

  flushOutbox() {
    for (const message of this.store.allMessages()) {
      if (message.dir !== 'out') continue;
      if (message.pending && message.pending.length) {
        for (const peerId of message.pending) this.deliver(message, peerId);
      } else if (message.status === 'queued') {
        this.deliver(message, message.conv);
      }
    }
  }

  async deliver(message, peerId) {
    const key = `${message.id}:${peerId}`;
    const peer = this.peers.get(peerId);
    if (this.sending.has(key) || !peer || !peer.online) return;
    this.sending.add(key);
    let channel;
    try {
      channel = await this.connect(peer);
      if (message.kind === 'file') {
        const { fileId, name, size } = message.file;
        await channel.send({ t: 'offer', id: message.id, fileId, name, size });
      } else {
        await channel.send({ t: 'msg', id: message.id, text: message.text, group: message.conv === EVERYONE });
      }
      const reply = await channel.recv();
      channel.close();
      if (reply.t !== 'ack' || reply.id !== message.id) throw new Error('bad acknowledgement');
      if (message.pending) {
        message.pending = message.pending.filter((id) => id !== peerId);
      }
      message.status = 'delivered';
      this.store.save();
      this.emit('updated', message);
    } catch {
      // The message stays queued, and the next heartbeat or peer return retries it.
      if (channel) channel.destroy();
    } finally {
      this.sending.delete(key);
    }
  }

  // True the first time this sender uses this message ID. A lost ack causes a resend.
  firstDelivery(from, id) {
    const key = `${from}:${id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async onMessage(channel, request) {
    const { id: from } = channel.remote;
    if (typeof request.id !== 'string' || request.id.length > 64 || typeof request.text !== 'string') {
      throw new Error('bad message');
    }
    if (Buffer.byteLength(request.text) > MAX_TEXT) throw new Error('message too long');
    if (this.firstDelivery(from, request.id)) {
      const message = {
        id: request.id,
        ts: Date.now(),
        from,
        fromName: this.remoteName(channel),
        conv: request.group ? EVERYONE : from,
        dir: 'in',
        kind: 'text',
        text: request.text,
      };
      this.store.addMessage(message);
      this.emit('message', message);
    }
    await channel.send({ t: 'ack', id: request.id });
  }

  remoteName(channel) {
    const known = this.peers.get(channel.remote.id);
    const name = cleanName(channel.remote.name);
    if (!known) {
      this.peers.set(channel.remote.id, { id: channel.remote.id, name, online: false });
      this.store.data.peers[channel.remote.id] = { id: channel.remote.id, name };
      this.emit('peers');
    }
    return known ? known.name : name;
  }

  // ---- Files ----

  async onOffer(channel, request) {
    const { id: from } = channel.remote;
    const validSize = Number.isSafeInteger(request.size) && request.size >= 0;
    if (typeof request.id !== 'string' || request.id.length > 64 || typeof request.fileId !== 'string'
      || request.fileId.length > 64 || !validSize) {
      throw new Error('bad offer');
    }
    if (this.firstDelivery(from, request.id)) {
      const message = {
        id: request.id,
        ts: Date.now(),
        from,
        fromName: this.remoteName(channel),
        conv: from,
        dir: 'in',
        kind: 'file',
        file: { fileId: request.fileId, name: safeFileName(request.name), size: request.size, state: 'offered' },
      };
      this.store.addMessage(message);
      this.emit('message', message);
    }
    await channel.send({ t: 'ack', id: request.id });
  }

  async onFileRequest(channel, request) {
    const offer = this.store.data.offers[request.fileId];
    // The offer is bound to one verified peer, so others can't fetch it by guessing the ID.
    if (!offer || offer.to !== channel.remote.id) {
      await channel.send({ t: 'file-error', reason: 'Offer not found' });
      return;
    }
    const message = this.store.conversation(offer.to).find((item) => item.file && item.file.fileId === request.fileId);
    const hash = crypto.createHash('sha256');
    let sent = 0;
    let lastEmit = 0;
    if (message) this.setFileState(message, 'sending', { transferred: 0 });
    try {
      const stream = fs.createReadStream(offer.path, { highWaterMark: CHUNK_SIZE });
      for await (const chunk of stream) {
        hash.update(chunk);
        await channel.sendBinary(chunk);
        sent += chunk.length;
        if (message && Date.now() - lastEmit > 100) {
          lastEmit = Date.now();
          this.setFileState(message, 'sending', { transferred: sent });
        }
      }
    } catch (err) {
      if (err.code) await channel.send({ t: 'file-error', reason: 'File is no longer available' }).catch(() => {});
      if (message) this.setFileState(message, 'offered');
      throw err;
    }
    await channel.send({ t: 'file-end', sha256: hash.digest('hex') });
    await channel.recv();
    if (message) this.setFileState(message, 'done', { transferred: sent });
  }

  onFileDeclined(channel, request) {
    const offer = this.store.data.offers[request.fileId];
    if (!offer || offer.to !== channel.remote.id) return;
    const message = this.store.conversation(offer.to).find((item) => item.file && item.file.fileId === request.fileId);
    if (message) this.setFileState(message, 'declined');
    delete this.store.data.offers[request.fileId];
    this.store.save();
  }

  setFileState(message, state, extra = {}) {
    Object.assign(message.file, { state }, extra);
    this.store.save();
    this.emit('updated', message);
  }

  async declineFile(conv, id) {
    const message = this.requireIncomingFile(conv, id);
    this.setFileState(message, 'declined');
    const peer = this.peers.get(message.from);
    if (!peer || !peer.online) return;
    const channel = await this.connect(peer).catch(() => null);
    if (channel) {
      await channel.send({ t: 'file-declined', fileId: message.file.fileId }).catch(() => {});
      channel.close();
    }
  }

  requireIncomingFile(conv, id) {
    const message = this.store.findMessage(conv, id);
    if (!message || message.dir !== 'in' || message.kind !== 'file') throw new Error('File not found');
    return message;
  }

  // Runs only after the user accepts. Data goes to a .part file until its checksum matches.
  async acceptFile(conv, id) {
    const message = this.requireIncomingFile(conv, id);
    if (['receiving', 'done'].includes(message.file.state)) return message;
    const peer = this.peers.get(message.from);
    if (!peer || !peer.online) throw new Error(`${message.fromName} is offline`);
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const target = uniquePath(this.downloadDir, message.file.name);
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    this.setFileState(message, 'receiving', { transferred: 0, error: null });
    let handle;
    let channel;
    try {
      channel = await this.connect(peer);
      await channel.send({ t: 'file-get', fileId: message.file.fileId });
      handle = await fs.promises.open(temp, 'wx');
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastEmit = 0;
      for (;;) {
        const frame = await channel.recv();
        if (Buffer.isBuffer(frame)) {
          received += frame.length;
          if (received > message.file.size) throw new Error('Sender sent more data than offered');
          hash.update(frame);
          await handle.writeFile(frame);
          if (Date.now() - lastEmit > 200) {
            lastEmit = Date.now();
            this.setFileState(message, 'receiving', { transferred: received });
          }
        } else if (frame.t === 'file-end') {
          if (received !== message.file.size) throw new Error('File is incomplete');
          if (frame.sha256 !== hash.digest('hex')) throw new Error('Checksum did not match');
          break;
        } else if (frame.t === 'file-error') {
          throw new Error(cleanName(frame.reason));
        } else {
          throw new Error('Unexpected data from sender');
        }
      }
      await handle.close();
      handle = null;
      const finalPath = uniquePath(this.downloadDir, message.file.name);
      await fs.promises.rename(temp, finalPath);
      await channel.send({ t: 'file-done' }).catch(() => {});
      channel.close();
      this.setFileState(message, 'done', { transferred: received, savedPath: finalPath });
      return message;
    } catch (err) {
      if (channel) channel.destroy();
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      this.setFileState(message, 'failed', { error: err.message });
      throw err;
    }
  }
}

module.exports = { Engine, EVERYONE, safeFileName };
