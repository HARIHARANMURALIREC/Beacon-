'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { Engine, EVERYONE, safeFileName } = require('../src/core/engine');
const { createIdentity, clientHandshake, serverHandshake } = require('../src/core/channel');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-test-'));
let nextPort = 34000 + Math.floor(Math.random() * 1000);
const running = new Set();

async function makeEngine(name, targets = [], udpPort = nextPort++) {
  const dir = path.join(root, `${name}-${crypto.randomUUID()}`);
  const engine = new Engine({
    dataDir: path.join(dir, 'data'),
    downloadDir: path.join(dir, 'downloads'),
    name,
    udpPort,
    tcpPort: 0,
    targets,
    heartbeatMs: 100,
    peerTimeoutMs: 1000,
  });
  await engine.start();
  running.add(engine);
  return engine;
}

async function stopEngine(engine) {
  running.delete(engine);
  await engine.stop();
}

async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function pair() {
  const portA = nextPort++;
  const portB = nextPort++;
  const a = await makeEngine('Asha', [`127.0.0.1:${portB}`], portA);
  const b = await makeEngine('Ben', [`127.0.0.1:${portA}`], portB);
  await waitFor(() => a.peers.get(b.id)?.online && b.peers.get(a.id)?.online, 'discovery');
  return { a, b };
}

const incoming = (engine, conv) => engine.store.conversation(conv).filter((m) => m.dir === 'in');

after(async () => {
  await Promise.all([...running].map((engine) => engine.stop()));
  fs.rmSync(root, { recursive: true, force: true });
});

test('peers discover each other with names', async () => {
  const { a, b } = await pair();
  assert.equal(a.listPeers().find((p) => p.id === b.id).name, 'Ben');
  assert.equal(b.listPeers().find((p) => p.id === a.id).name, 'Asha');
});

test('text is delivered and acknowledged', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'hello there');
  await waitFor(() => sent.status === 'delivered', 'ack');
  const [received] = incoming(b, a.id);
  assert.equal(received.text, 'hello there');
  assert.equal(received.from, a.id);
});

test('a resent message is shown only once', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'once');
  await waitFor(() => sent.status === 'delivered', 'ack');
  sent.status = 'queued';
  a.flushOutbox();
  await waitFor(() => sent.status === 'delivered', 'second ack');
  assert.equal(incoming(b, a.id).length, 1);
});

test('messages queued while offline arrive when the peer returns', async () => {
  const { a, b } = await pair();
  const dataDir = path.dirname(b.store.file);
  const downloadDir = b.downloadDir;
  const { udpPort, targets } = b;
  await stopEngine(b);
  await waitFor(() => !a.peers.get(b.id).online, 'peer offline');
  const sent = a.sendText(b.id, 'while you were out');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sent.status, 'queued');
  const back = new Engine({ dataDir, downloadDir, name: 'Ben', udpPort, tcpPort: 0, targets, heartbeatMs: 100, peerTimeoutMs: 1000 });
  await back.start();
  running.add(back);
  await waitFor(() => sent.status === 'delivered', 'delivery after return');
  assert.equal(incoming(back, a.id)[0].text, 'while you were out');
});

test('history survives a restart', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'keep me');
  await waitFor(() => sent.status === 'delivered', 'ack');
  const dataDir = path.dirname(b.store.file);
  const id = b.id;
  await stopEngine(b);
  const back = new Engine({ dataDir, downloadDir: b.downloadDir, name: 'Ben', udpPort: nextPort++, tcpPort: 0 });
  assert.equal(back.id, id, 'device identity is stable');
  assert.equal(back.store.conversation(a.id)[0].text, 'keep me');
});

test('everyone message reaches all online peers', async () => {
  const [pa, pb, pc] = [nextPort++, nextPort++, nextPort++];
  const a = await makeEngine('A', [`127.0.0.1:${pb}`, `127.0.0.1:${pc}`], pa);
  const b = await makeEngine('B', [`127.0.0.1:${pa}`], pb);
  const c = await makeEngine('C', [`127.0.0.1:${pa}`], pc);
  await waitFor(() => a.peers.get(b.id)?.online && a.peers.get(c.id)?.online, 'discovery');
  a.sendText(EVERYONE, 'all hands');
  await waitFor(() => incoming(b, EVERYONE).length && incoming(c, EVERYONE).length, 'group delivery');
  assert.equal(incoming(c, EVERYONE)[0].text, 'all hands');
});

test('file transfer waits for acceptance and arrives intact', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `big-${crypto.randomUUID()}.bin`);
  const content = crypto.randomBytes(5 * 1024 * 1024 + 123);
  fs.writeFileSync(source, content);
  const offer = a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  const [received] = incoming(b, a.id);
  assert.equal(received.file.state, 'offered');
  assert.ok(!fs.existsSync(b.downloadDir), 'nothing is written before acceptance');
  await b.acceptFile(a.id, received.id);
  assert.equal(received.file.state, 'done');
  assert.ok(fs.readFileSync(received.file.savedPath).equals(content));
  assert.deepEqual(fs.readdirSync(b.downloadDir).filter((f) => f.endsWith('.part')), []);
  await waitFor(() => offer.file.state === 'done', 'sender completion');
});

test('empty files transfer correctly', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `empty-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(source, '');
  const offer = a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  const [received] = incoming(b, a.id);
  await b.acceptFile(a.id, received.id);
  assert.equal(fs.statSync(received.file.savedPath).size, 0);
});

test('a changed file fails verification and leaves nothing behind', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `changed-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(source, 'original');
  const offer = a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  fs.writeFileSync(source, 'a much longer replacement');
  const [received] = incoming(b, a.id);
  await assert.rejects(b.acceptFile(a.id, received.id));
  assert.equal(received.file.state, 'failed');
  assert.deepEqual(fs.readdirSync(b.downloadDir), []);
});

test('another device cannot fetch a file offered to someone else', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `secret-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(source, 'for Ben only');
  const offer = a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  const socket = net.connect({ host: '127.0.0.1', port: a.listenPort });
  await new Promise((resolve) => socket.once('connect', resolve));
  const channel = await clientHandshake(socket, createIdentity(), 'Mallory', a.id);
  await channel.send({ t: 'file-get', fileId: offer.file.fileId });
  const reply = await channel.recv();
  assert.equal(reply.t, 'file-error');
  channel.destroy();
});

test('a device cannot answer for another peer', async () => {
  const identity = createIdentity();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    serverHandshake(socket, identity, 'Impostor').catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  await assert.rejects(clientHandshake(socket, createIdentity(), 'Asha', 'a'.repeat(32)), /identity mismatch/);
  socket.destroy();
  server.close();
});

test('tampered traffic is rejected', async () => {
  const serverIdentity = createIdentity();
  const { idFromPublicKey } = require('../src/core/channel');
  let serverChannel;
  const server = net.createServer(async (socket) => {
    socket.on('error', () => {});
    serverChannel = await serverHandshake(socket, serverIdentity, 'S');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
  await new Promise((resolve) => socket.once('connect', resolve));
  const client = await clientHandshake(socket, createIdentity(), 'C', idFromPublicKey(serverIdentity.publicKey));
  await waitFor(() => serverChannel, 'server channel');
  // Advancing the counter makes this frame's nonce wrong, like a replayed or altered frame.
  client.sendCounter += 1n;
  await client.send({ t: 'msg', text: 'forged' });
  await assert.rejects(serverChannel.recv());
  client.destroy();
  server.close();
});

test('malformed discovery and connections do not crash the app', async () => {
  const { a, b } = await pair();
  const dgram = require('node:dgram');
  const udp = dgram.createSocket('udp4');
  for (const junk of ['not json', '{}', '{"app":"beacon","v":1,"t":"hello","id":"../../x","tcp":1}']) {
    await new Promise((resolve) => udp.send(junk, a.udpPort, '127.0.0.1', resolve));
  }
  udp.close();
  const socket = net.connect({ host: '127.0.0.1', port: a.listenPort });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
  await new Promise((resolve) => socket.once('close', resolve));
  const sent = a.sendText(b.id, 'still working');
  await waitFor(() => sent.status === 'delivered', 'delivery after junk');
});

test('sender-supplied file names cannot leave the download folder', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(safeFileName('.bashrc'), 'bashrc');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('a:b?.txt'), 'a_b_.txt');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName(''), 'file');
});
