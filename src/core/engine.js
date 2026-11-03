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
const GROUP_ID_PATTERN = /^g:[a-f0-9-]{36}$/;
const MAX_TEXT = 64 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_GROUP_MEMBERS = 256;
const MAX_FOLDER_ENTRIES = 200000;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_NAME = 64;
const MAX_PEERS = 5000;
const MAX_CONNECTIONS = 128;
const CHUNK_SIZE = 256 * 1024;
const IDLE_TIMEOUT_MS = 60000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

function cleanLabel(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
}

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

// A sender controls these paths too. Each part stays inside the folder being received.
function safeRelativePath(value) {
  const parts = String(value ?? '').split(/[\\/]/);
  if (!parts.length || parts.length > 64) throw new Error('Unsafe path in folder');
  return path.join(...parts.map((part) => {
    if (!part || part === '.' || part === '..') throw new Error('Unsafe path in folder');
    const clean = part.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[.\s]+$/, '');
    if (!clean) throw new Error('Unsafe path in folder');
    return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `_${clean}` : clean.slice(0, 200);
  }));
}

// Trusts the file's first bytes rather than anything the sender says it is. SVG can hold scripts, so it's excluded.
function imageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function walkFolder(root) {
  const result = { dirs: [], files: [], size: 0 };
  const visit = async (relative) => {
    const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (result.dirs.length + result.files.length >= MAX_FOLDER_ENTRIES) throw new Error('Folder has too many files');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Links could point outside the folder the user chose, so they're skipped.
      if (entry.isDirectory()) {
        result.dirs.push(child);
        await visit(child);
      } else if (entry.isFile()) {
        const { size } = await fs.promises.stat(path.join(root, child));
        result.files.push({ path: child, size });
        result.size += size;
      }
    }
  };
  await visit('');
  return result;
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
    this.configure(options);
    this.store.data.groups = this.store.data.groups || {};
    this.store.data.receipts = this.store.data.receipts || {};
    this.imageDir = path.join(path.dirname(this.store.file), 'images');
    this.peers = new Map();
    this.awayReplied = new Set();
    this.outgoing = new Map();
    this.sending = new Set();
    this.seen = new Set();
    this.lastReply = new Map();
    this.connections = 0;
    for (const peer of Object.values(this.store.data.peers)) {
      this.peers.set(peer.id, { ...peer, online: false, ip: null, tcpPort: null, lastSeen: 0 });
    }
    for (const message of this.store.allMessages()) {
      if (message.dir === 'in') this.seen.add(`${message.from}:${message.id}`);
      else this.outgoing.set(message.id, message);
      if (message.file && ['receiving', 'sending'].includes(message.file.state)) message.file.state = 'offered';
    }
  }

  configure(options) {
    this.autoAccept = options.autoAccept ?? this.autoAccept ?? false;
    this.readReceipts = options.readReceipts ?? this.readReceipts ?? true;
    this.group = cleanLabel(options.group ?? this.group);
    this.awayText = String(options.awayText ?? this.awayText ?? '').slice(0, 1000);
    const away = options.away ?? this.away ?? false;
    if (away !== this.away) this.awayReplied = new Set();
    this.away = away;
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
    return Buffer.from(JSON.stringify({ app: 'beacon', v: 1, t: type, id: this.id, name: this.name, tcp: this.listenPort, away: this.away, group: this.group }));
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
    this.notePeer(message.id, cleanName(message.name), info.address, message.tcp, message.away === true, cleanLabel(message.group));
  }

  notePeer(id, name, ip, tcpPort, away = false, group = '') {
    let peer = this.peers.get(id);
    if (!peer) {
      if (this.peers.size >= MAX_PEERS) return;
      peer = { id, name };
      this.peers.set(id, peer);
    }
    const cameOnline = !peer.online;
    const changed = cameOnline || peer.name !== name || peer.ip !== ip || peer.away !== away || peer.group !== group;
    Object.assign(peer, { name, ip, tcpPort, away, group, online: true, lastSeen: Date.now() });
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
      away: Boolean(peer.online && peer.away),
      group: peer.group || '',
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
      else if (request.t === 'image') await this.onImage(channel, request);
      else if (request.t === 'read') await this.onRead(channel, request);
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

  recipientsFor(conv) {
    if (conv === EVERYONE) return [...this.peers.values()].filter((peer) => peer.online).map((peer) => peer.id);
    const group = this.store.data.groups[conv];
    return group ? group.members.filter((id) => id !== this.id) : null;
  }

  addOutgoing(fields) {
    const recipients = this.recipientsFor(fields.conv);
    if (!recipients && !this.peers.has(fields.conv)) throw new Error('Unknown user');
    const extra = recipients ? { status: 'sent', recipients, pending: [...recipients] } : {};
    const message = this.newMessage({ ...fields, ...extra });
    this.store.addMessage(message);
    this.outgoing.set(message.id, message);
    this.emit('message', message);
    this.flushOutbox();
    return message;
  }

  sendText(conv, rawText, options = {}) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new Error('Message is empty');
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('Message is too long');
    const fields = { conv, kind: 'text', text };
    if (options.reply && typeof options.reply.id === 'string') {
      fields.reply = { id: options.reply.id.slice(0, 64), name: cleanName(options.reply.name), text: String(options.reply.text ?? '').slice(0, 200) };
    }
    if (options.auto) fields.auto = true;
    if (options.sealed) fields.sealed = true;
    if (options.password) {
      fields.text = '';
      fields.sealed = true;
      fields.locked = this.lockText(text, String(options.password));
    }
    return this.addOutgoing(fields);
  }

  // ---- Sealed and locked messages ----

  lockText(text, password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  // The opened text is returned but never saved, so history keeps only the locked form.
  unlockMessage(conv, id, password) {
    const message = this.store.findMessage(conv, id);
    if (!message || !message.locked) throw new Error('Message not found');
    const { salt, iv, tag, ct } = message.locked;
    let text;
    try {
      const key = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), 32, SCRYPT);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      text = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Wrong password');
    }
    if (message.dir === 'in') this.openMessage(message);
    return text;
  }

  openSealed(conv, id) {
    const message = this.store.findMessage(conv, id);
    if (!message || message.dir !== 'in' || !message.sealed) throw new Error('Message not found');
    this.openMessage(message);
  }

  openMessage(message) {
    if (message.opened) return;
    message.opened = true;
    this.queueReceipt(message);
    this.store.save();
    this.emit('updated', message);
  }

  // ---- Read receipts ----

  queueReceipt(message) {
    if (message.receipted) return;
    message.receipted = true;
    const list = this.store.data.receipts[message.from] || (this.store.data.receipts[message.from] = []);
    list.push(message.id);
    this.store.save();
    this.flushReceipts();
  }

  // Everyone messages would flood the sender, so only sealed ones report back.
  markRead(conv) {
    if (!this.readReceipts) return;
    for (const message of this.store.data.messages[conv] || []) {
      if (message.dir === 'in' && !message.sealed && conv !== EVERYONE) this.queueReceipt(message);
    }
  }

  async flushReceipts() {
    for (const [peerId, ids] of Object.entries(this.store.data.receipts)) {
      const peer = this.peers.get(peerId);
      const key = `receipts:${peerId}`;
      if (!ids.length || !peer || !peer.online || this.sending.has(key)) continue;
      this.sending.add(key);
      let channel;
      try {
        channel = await this.connect(peer);
        const batch = ids.slice(0, 500);
        await channel.send({ t: 'read', ids: batch });
        await channel.recv();
        channel.close();
        this.store.data.receipts[peerId] = this.store.data.receipts[peerId].filter((id) => !batch.includes(id));
        this.store.save();
      } catch {
        // Kept for the next heartbeat.
        if (channel) channel.destroy();
      } finally {
        this.sending.delete(key);
      }
    }
  }

  async onRead(channel, request) {
    const { id: from } = channel.remote;
    if (!Array.isArray(request.ids) || request.ids.length > 500) throw new Error('bad receipt');
    for (const id of request.ids) {
      const message = this.outgoing.get(id);
      // Only someone the message was sent to can mark it read.
      if (!message || !(message.conv === from || (message.recipients || []).includes(from))) continue;
      message.readBy = [...new Set([...(message.readBy || []), from])];
      this.emit('updated', message);
    }
    this.store.save();
    await channel.send({ t: 'ack' });
  }

  // ---- Groups ----

  createGroup(name, memberIds) {
    const members = [...new Set(memberIds)].filter((id) => this.peers.has(id));
    if (!members.length) throw new Error('Choose at least one person');
    if (members.length >= MAX_GROUP_MEMBERS) throw new Error('Group is too large');
    const group = { id: `g:${crypto.randomUUID()}`, name: cleanName(name), members: [this.id, ...members] };
    this.store.data.groups[group.id] = group;
    this.store.save();
    this.emit('groups');
    return group;
  }

  groupMeta(conv) {
    const group = this.store.data.groups[conv];
    if (!group) return undefined;
    const names = {};
    for (const id of group.members) names[id] = id === this.id ? this.name : (this.peers.get(id) || {}).name || 'Unknown';
    return { id: group.id, name: group.name, members: group.members, names };
  }

  // Returns the conversation for an incoming message, or throws if the sender doesn't belong.
  incomingConversation(channel, request) {
    const { id: from } = channel.remote;
    if (!request.gid) return request.group ? EVERYONE : from;
    const { id, name, members, names } = request.gid;
    const valid = GROUP_ID_PATTERN.test(id) && Array.isArray(members) && members.length <= MAX_GROUP_MEMBERS
      && members.every((member) => ID_PATTERN.test(member)) && members.includes(from) && members.includes(this.id);
    if (!valid) throw new Error('bad group');
    const existing = this.store.data.groups[id];
    if (existing) {
      if (!existing.members.includes(from)) throw new Error('not a group member');
      return id;
    }
    for (const member of members) {
      if (member !== this.id && !this.peers.has(member) && this.peers.size < MAX_PEERS) {
        const memberName = cleanName(names && names[member]);
        this.peers.set(member, { id: member, name: memberName, online: false });
        this.store.data.peers[member] = { id: member, name: memberName };
      }
    }
    this.store.data.groups[id] = { id, name: cleanName(name), members: [...new Set(members)] };
    this.store.save();
    this.emit('groups');
    this.emit('peers');
    return id;
  }

  // ---- Images ----

  sendImage(conv, data) {
    const buffer = Buffer.from(data);
    if (buffer.length > MAX_IMAGE) throw new Error('Images can be up to 10 MB. Send larger ones as a file.');
    const mime = imageType(buffer);
    if (!mime) throw new Error('This image type is not supported');
    fs.mkdirSync(this.imageDir, { recursive: true });
    const file = path.join(this.imageDir, `${crypto.randomUUID()}.${IMAGE_TYPES[mime]}`);
    fs.writeFileSync(file, buffer);
    return this.addOutgoing({ conv, kind: 'image', image: { mime, size: buffer.length, path: file } });
  }

  imageData(conv, id) {
    const message = this.store.findMessage(conv, id);
    if (!message || message.kind !== 'image') throw new Error('Image not found');
    return `data:${message.image.mime};base64,${fs.readFileSync(message.image.path).toString('base64')}`;
  }

  async onImage(channel, request) {
    const { id: from } = channel.remote;
    if (typeof request.id !== 'string' || request.id.length > 64 || !Number.isSafeInteger(request.size)
      || request.size < 1 || request.size > MAX_IMAGE) {
      throw new Error('bad image');
    }
    const conv = this.incomingConversation(channel, request);
    const chunks = [];
    let received = 0;
    const hash = crypto.createHash('sha256');
    for (;;) {
      const frame = await channel.recv();
      if (Buffer.isBuffer(frame)) {
        received += frame.length;
        if (received > request.size) throw new Error('image too large');
        hash.update(frame);
        chunks.push(frame);
      } else if (frame.t === 'image-end') {
        if (received !== request.size || frame.sha256 !== hash.digest('hex')) throw new Error('bad image data');
        break;
      } else {
        throw new Error('unexpected frame');
      }
    }
    const buffer = Buffer.concat(chunks);
    const mime = imageType(buffer);
    if (!mime) throw new Error('not an image');
    if (this.firstDelivery(from, request.id)) {
      await fs.promises.mkdir(this.imageDir, { recursive: true });
      const file = path.join(this.imageDir, `${crypto.randomUUID()}.${IMAGE_TYPES[mime]}`);
      await fs.promises.writeFile(file, buffer);
      const message = {
        id: request.id, ts: Date.now(), from, fromName: this.remoteName(channel), conv, dir: 'in', kind: 'image',
        image: { mime, size: buffer.length, path: file },
      };
      this.store.addMessage(message);
      this.emit('message', message);
    }
    await channel.send({ t: 'ack', id: request.id });
  }

  // ---- Delivery ----

  async offerFile(conv, filePath) {
    if (conv === EVERYONE || !this.peers.has(conv)) throw new Error('Files and folders can only be sent to one person');
    const stat = await fs.promises.stat(filePath);
    const fileId = crypto.randomUUID();
    const name = safeFileName(path.basename(filePath));
    const file = { fileId, name, size: stat.size, state: 'offered' };
    if (stat.isDirectory()) {
      const contents = await walkFolder(filePath);
      Object.assign(file, { folder: true, size: contents.size, count: contents.files.length });
    } else if (!stat.isFile()) {
      throw new Error('Only files and folders can be sent');
    }
    this.store.data.offers[fileId] = { path: filePath, to: conv };
    return this.addOutgoing({ conv, kind: 'file', file });
  }

  flushOutbox() {
    this.flushReceipts();
    for (const message of this.store.allMessages()) {
      if (message.dir === 'in') {
        // An offer can arrive before discovery finds its sender, so this also retries later.
        const sender = this.peers.get(message.from);
        if (this.autoAccept && message.kind === 'file' && message.file.state === 'offered' && sender && sender.online) {
          this.acceptFile(message.conv, message.id).catch(() => {});
        }
      } else if (message.pending && message.pending.length) {
        for (const peerId of message.pending) this.deliver(message, peerId);
      } else if (message.status === 'queued') {
        this.deliver(message, message.conv);
      }
    }
  }

  async sendPayload(channel, message) {
    const gid = this.groupMeta(message.conv);
    if (message.kind === 'file') {
      const { fileId, name, size, folder, count } = message.file;
      await channel.send({ t: 'offer', id: message.id, fileId, name, size, folder, count });
    } else if (message.kind === 'image') {
      const data = await fs.promises.readFile(message.image.path);
      await channel.send({ t: 'image', id: message.id, size: data.length, gid, group: message.conv === EVERYONE });
      for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        await channel.sendBinary(data.subarray(offset, offset + CHUNK_SIZE));
      }
      await channel.send({ t: 'image-end', sha256: crypto.createHash('sha256').update(data).digest('hex') });
    } else {
      const { id, text, reply, sealed, locked, auto } = message;
      await channel.send({ t: 'msg', id, text, reply, sealed, locked, auto, gid, group: message.conv === EVERYONE });
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
      await this.sendPayload(channel, message);
      const reply = await channel.recv();
      channel.close();
      if (reply.t !== 'ack' || reply.id !== message.id) throw new Error('bad acknowledgement');
      if (message.pending) {
        message.pending = message.pending.filter((id) => id !== peerId);
      }
      if (!message.recipients) message.status = 'delivered';
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
    const locked = request.locked;
    if (locked && !['salt', 'iv', 'tag', 'ct'].every((part) => typeof locked[part] === 'string' && locked[part].length <= MAX_TEXT * 2)) {
      throw new Error('bad locked message');
    }
    if (!request.text && !locked) throw new Error('empty message');
    const conv = this.incomingConversation(channel, request);
    if (this.firstDelivery(from, request.id)) {
      const message = {
        id: request.id,
        ts: Date.now(),
        from,
        fromName: this.remoteName(channel),
        conv,
        dir: 'in',
        kind: 'text',
        text: request.text,
      };
      if (locked) message.locked = locked;
      if (request.sealed || locked) message.sealed = true;
      if (request.auto === true) message.auto = true;
      if (request.reply && typeof request.reply.id === 'string') {
        message.reply = { id: request.reply.id.slice(0, 64), name: cleanName(request.reply.name), text: String(request.reply.text ?? '').slice(0, 200) };
      }
      this.store.addMessage(message);
      this.emit('message', message);
      // Only direct messages get the away reply, and only once, so two away people can't loop.
      if (this.away && this.awayText && conv === from && !message.auto && !this.awayReplied.has(from)) {
        this.awayReplied.add(from);
        setImmediate(() => this.sendText(from, this.awayText, { auto: true }));
      }
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
      if (request.folder === true) {
        message.file.folder = true;
        message.file.count = Number.isSafeInteger(request.count) ? request.count : 0;
      }
      this.store.addMessage(message);
      this.emit('message', message);
    }
    await channel.send({ t: 'ack', id: request.id });
    if (this.autoAccept) setImmediate(() => this.flushOutbox());
  }

  async onFileRequest(channel, request) {
    const offer = this.store.data.offers[request.fileId];
    // The offer is bound to one verified peer, so others can't fetch it by guessing the ID.
    if (!offer || offer.to !== channel.remote.id) {
      await channel.send({ t: 'file-error', reason: 'Offer not found' });
      return;
    }
    const message = this.store.conversation(offer.to).find((item) => item.file && item.file.fileId === request.fileId);
    let sent = 0;
    let lastEmit = 0;
    const onBytes = (count) => {
      sent += count;
      if (message && Date.now() - lastEmit > 100) {
        lastEmit = Date.now();
        this.setFileState(message, 'sending', { transferred: sent });
      }
    };
    if (message) this.setFileState(message, 'sending', { transferred: 0 });
    try {
      if (message && message.file.folder) {
        const contents = await walkFolder(offer.path);
        if (contents.size !== message.file.size) {
          await channel.send({ t: 'file-error', reason: 'Folder changed after it was sent' });
          throw new Error('folder changed');
        }
        for (const dir of contents.dirs) await channel.send({ t: 'dir', path: dir });
        for (const file of contents.files) {
          await channel.send({ t: 'file-begin', path: file.path, size: file.size });
          await this.streamFile(channel, path.join(offer.path, file.path), onBytes);
        }
        await channel.send({ t: 'folder-end' });
      } else {
        await this.streamFile(channel, offer.path, onBytes);
      }
    } catch (err) {
      if (err.code) await channel.send({ t: 'file-error', reason: 'File is no longer available' }).catch(() => {});
      if (message) this.setFileState(message, 'offered');
      throw err;
    }
    await channel.recv();
    if (message) this.setFileState(message, 'done', { transferred: sent });
  }

  async streamFile(channel, filePath, onBytes) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE })) {
      hash.update(chunk);
      await channel.sendBinary(chunk);
      onBytes(chunk.length);
    }
    await channel.send({ t: 'file-end', sha256: hash.digest('hex') });
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

  // Data goes to a temporary path until every checksum matches.
  async acceptFile(conv, id) {
    const message = this.requireIncomingFile(conv, id);
    if (['receiving', 'done'].includes(message.file.state)) return message;
    const peer = this.peers.get(message.from);
    if (!peer || !peer.online) throw new Error(`${message.fromName} is offline`);
    this.setFileState(message, 'receiving', { transferred: 0, error: null });
    let channel;
    let temp;
    try {
      await fs.promises.mkdir(this.downloadDir, { recursive: true });
      const { bavail, bsize } = await fs.promises.statfs(this.downloadDir);
      if (message.file.size > bavail * bsize) throw new Error('Not enough disk space');
      temp = `${uniquePath(this.downloadDir, message.file.name)}.${crypto.randomBytes(4).toString('hex')}.part`;
      channel = await this.connect(peer);
      await channel.send({ t: 'file-get', fileId: message.file.fileId });
      let received = 0;
      let lastEmit = 0;
      const onBytes = (count) => {
        received += count;
        if (received > message.file.size) throw new Error('Sender sent more data than offered');
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now();
          this.setFileState(message, 'receiving', { transferred: received });
        }
      };
      if (message.file.folder) await this.receiveFolder(channel, message, temp, onBytes);
      else await this.receiveFile(channel, temp, message.file.size, onBytes);
      if (received !== message.file.size) throw new Error('Transfer is incomplete');
      const finalPath = uniquePath(this.downloadDir, message.file.name);
      await fs.promises.rename(temp, finalPath);
      await channel.send({ t: 'file-done' }).catch(() => {});
      channel.close();
      this.setFileState(message, 'done', { transferred: received, savedPath: finalPath });
      return message;
    } catch (err) {
      if (channel) channel.destroy();
      if (temp) await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
      this.setFileState(message, 'failed', { error: err.message });
      throw err;
    }
  }

  async receiveFile(channel, target, expected, onBytes) {
    const handle = await fs.promises.open(target, 'wx');
    try {
      const hash = crypto.createHash('sha256');
      let received = 0;
      for (;;) {
        const frame = await channel.recv();
        if (Buffer.isBuffer(frame)) {
          received += frame.length;
          if (received > expected) throw new Error('Sender sent more data than offered');
          onBytes(frame.length);
          hash.update(frame);
          await handle.writeFile(frame);
        } else if (frame.t === 'file-end') {
          if (received !== expected) throw new Error('File is incomplete');
          if (frame.sha256 !== hash.digest('hex')) throw new Error('Checksum did not match');
          return;
        } else if (frame.t === 'file-error') {
          throw new Error(cleanName(frame.reason));
        } else {
          throw new Error('Unexpected data from sender');
        }
      }
    } finally {
      await handle.close();
    }
  }

  async receiveFolder(channel, message, root, onBytes) {
    await fs.promises.mkdir(root);
    let files = 0;
    let entries = 0;
    const resolve = (value) => {
      const target = path.join(root, safeRelativePath(value));
      if (!target.startsWith(root + path.sep)) throw new Error('Unsafe path in folder');
      entries += 1;
      if (entries > MAX_FOLDER_ENTRIES) throw new Error('Folder has too many files');
      return target;
    };
    for (;;) {
      const frame = await channel.recv();
      if (Buffer.isBuffer(frame)) throw new Error('Unexpected data from sender');
      if (frame.t === 'dir') {
        await fs.promises.mkdir(resolve(frame.path), { recursive: true });
      } else if (frame.t === 'file-begin') {
        if (!Number.isSafeInteger(frame.size) || frame.size < 0) throw new Error('Bad file size');
        const target = resolve(frame.path);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await this.receiveFile(channel, target, frame.size, onBytes);
        files += 1;
      } else if (frame.t === 'folder-end') {
        if (files !== message.file.count) throw new Error('Folder is incomplete');
        return;
      } else if (frame.t === 'file-error') {
        throw new Error(cleanName(frame.reason));
      } else {
        throw new Error('Unexpected data from sender');
      }
    }
  }
}

module.exports = { Engine, EVERYONE, safeFileName, safeRelativePath };
