'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { Engine, EVERYONE, safeFileName, safeRelativePath } = require('../src/core/engine');
const { createIdentity, clientHandshake, serverHandshake } = require('../src/core/channel');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-test-'));
let nextPort = 34000 + Math.floor(Math.random() * 1000);
const running = new Set();

async function makeEngine(name, targets = [], udpPort = nextPort++, extra = {}) {
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
    ...extra,
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

async function pair(extraB = {}) {
  const portA = nextPort++;
  const portB = nextPort++;
  const a = await makeEngine('Asha', [`127.0.0.1:${portB}`], portA);
  const b = await makeEngine('Ben', [`127.0.0.1:${portA}`], portB, extraB);
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
  const offer = await a.offerFile(b.id, source);
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
  const offer = await a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  const [received] = incoming(b, a.id);
  await b.acceptFile(a.id, received.id);
  assert.equal(fs.statSync(received.file.savedPath).size, 0);
});

test('a changed file fails verification and leaves nothing behind', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `changed-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(source, 'original');
  const offer = await a.offerFile(b.id, source);
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
  const offer = await a.offerFile(b.id, source);
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

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(600 * 1024)]);

test('files download automatically when auto-accept is on', async () => {
  const { a, b } = await pair({ autoAccept: true });
  const source = path.join(root, `auto-${crypto.randomUUID()}.bin`);
  const content = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(source, content);
  const offer = await a.offerFile(b.id, source);
  await waitFor(() => offer.file.state === 'done', 'sender finished');
  const [received] = incoming(b, a.id);
  await waitFor(() => received.file.state === 'done', 'receiver finished');
  assert.ok(fs.readFileSync(received.file.savedPath).equals(content));
});

test('a folder arrives complete, including nested and empty folders', async () => {
  const { a, b } = await pair({ autoAccept: true });
  const source = path.join(root, `Project-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(source, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'));
  const big = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(source, 'readme.txt'), 'hello');
  fs.writeFileSync(path.join(source, '.config'), 'hidden');
  fs.writeFileSync(path.join(source, 'docs', 'deep', 'big.bin'), big);
  fs.writeFileSync(path.join(source, 'blank.txt'), '');
  fs.symlinkSync('/etc/hosts', path.join(source, 'link-outside'));
  const offer = await a.offerFile(b.id, source);
  assert.equal(offer.file.count, 4);
  await waitFor(() => offer.file.state === 'done', 'sender finished');
  const [received] = incoming(b, a.id);
  await waitFor(() => received.file.state === 'done', 'receiver finished');
  const saved = received.file.savedPath;
  assert.equal(fs.readFileSync(path.join(saved, 'readme.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(saved, '.config'), 'utf8'), 'hidden');
  assert.ok(fs.readFileSync(path.join(saved, 'docs', 'deep', 'big.bin')).equals(big));
  assert.equal(fs.statSync(path.join(saved, 'blank.txt')).size, 0);
  assert.ok(fs.statSync(path.join(saved, 'empty')).isDirectory());
  assert.ok(!fs.existsSync(path.join(saved, 'link-outside')), 'links are not sent');
  assert.deepEqual(fs.readdirSync(b.downloadDir).filter((f) => f.endsWith('.part')), []);
});

test('folder paths from a sender cannot escape the destination', () => {
  for (const bad of ['../evil', 'a/../../evil', '..\\evil', 'a//b', '', '.', 'a/./b']) {
    assert.throws(() => safeRelativePath(bad), /Unsafe/, bad);
  }
  assert.equal(safeRelativePath('docs/.config'), path.join('docs', '.config'));
  assert.equal(safeRelativePath('CON/a:b.txt'), path.join('_CON', 'a_b.txt'));
});

test('a malicious folder stream leaves nothing outside the download folder', async () => {
  const { a, b } = await pair();
  const source = path.join(root, `folder-${crypto.randomUUID()}`);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'ok.txt'), 'x');
  const offer = await a.offerFile(b.id, source);
  await waitFor(() => offer.status === 'delivered', 'offer');
  // Replace the honest sender's stream with one that tries to climb out.
  a.onFileRequest = async (channel) => {
    await channel.send({ t: 'file-begin', path: '../../escaped.txt', size: 1 });
    await channel.sendBinary(Buffer.from('x'));
  };
  const [received] = incoming(b, a.id);
  await assert.rejects(b.acceptFile(a.id, received.id), /Unsafe/);
  assert.deepEqual(fs.readdirSync(b.downloadDir), []);
  assert.ok(!fs.existsSync(path.join(path.dirname(b.downloadDir), 'escaped.txt')));
});

test('a chosen group reaches only its members, and members can reply to all', async () => {
  const [pa, pb, pc, pd] = [nextPort++, nextPort++, nextPort++, nextPort++];
  const others = (self) => [pa, pb, pc, pd].filter((p) => p !== self).map((p) => `127.0.0.1:${p}`);
  const a = await makeEngine('A', others(pa), pa);
  const b = await makeEngine('B', others(pb), pb);
  const c = await makeEngine('C', others(pc), pc);
  const d = await makeEngine('D', others(pd), pd);
  await waitFor(() => [b, c, d].every((e) => a.peers.get(e.id)?.online) && b.peers.get(c.id)?.online && c.peers.get(b.id)?.online, 'discovery');
  const group = a.createGroup('Design', [b.id, c.id]);
  const sent = a.sendText(group.id, 'group hello');
  await waitFor(() => incoming(b, group.id).length && incoming(c, group.id).length, 'group delivery');
  await waitFor(() => sent.pending.length === 0, 'delivered to all');
  assert.equal(b.store.data.groups[group.id].name, 'Design');
  assert.equal(d.store.data.messages[group.id], undefined, 'non-member gets nothing');
  c.sendText(group.id, 'reply to all');
  await waitFor(() => incoming(a, group.id).length && incoming(b, group.id).length === 2, 'reply delivery');
  assert.equal(incoming(a, group.id)[0].from, c.id);
});

test('someone outside a group cannot post into it', async () => {
  const [pa, pb, pc] = [nextPort++, nextPort++, nextPort++];
  const others = (self) => [pa, pb, pc].filter((p) => p !== self).map((p) => `127.0.0.1:${p}`);
  const a = await makeEngine('A', others(pa), pa);
  const b = await makeEngine('B', others(pb), pb);
  const c = await makeEngine('C', others(pc), pc);
  await waitFor(() => a.peers.get(b.id)?.online && c.peers.get(a.id)?.online, 'discovery');
  const group = a.createGroup('Private', [b.id]);
  const socket = net.connect({ host: '127.0.0.1', port: a.listenPort });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  const channel = await clientHandshake(socket, c.identity, 'C', a.id);
  await channel.send({ t: 'msg', id: 'x1', text: 'intruder', gid: { id: group.id, name: 'Private', members: [a.id, c.id] } });
  await assert.rejects(channel.recv());
  assert.deepEqual(incoming(a, group.id), []);
  channel.destroy();
});

test('read receipts report back, and can be turned off', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'did you see this');
  await waitFor(() => sent.status === 'delivered', 'ack');
  assert.equal(sent.readBy, undefined);
  b.markRead(a.id);
  await waitFor(() => sent.readBy?.includes(b.id), 'read receipt');
  b.configure({ readReceipts: false });
  const second = a.sendText(b.id, 'private reading');
  await waitFor(() => second.status === 'delivered', 'ack');
  b.markRead(a.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(second.readBy, undefined);
});

test('only a recipient can mark a message read', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'for Ben');
  await waitFor(() => sent.status === 'delivered', 'ack');
  const socket = net.connect({ host: '127.0.0.1', port: a.listenPort });
  await new Promise((resolve) => socket.once('connect', resolve));
  const channel = await clientHandshake(socket, createIdentity(), 'Mallory', a.id);
  await channel.send({ t: 'read', ids: [sent.id] });
  await channel.recv();
  assert.equal(sent.readBy, undefined);
  channel.destroy();
});

test('a sealed message reports when it is opened, even with receipts off', async () => {
  const { a, b } = await pair({ readReceipts: false });
  const sent = a.sendText(b.id, 'sealed text', { sealed: true });
  await waitFor(() => sent.status === 'delivered', 'ack');
  const [received] = incoming(b, a.id);
  assert.equal(received.sealed, true);
  b.markRead(a.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sent.readBy, undefined, 'viewing the chat is not opening it');
  b.openSealed(a.id, received.id);
  await waitFor(() => sent.readBy?.includes(b.id), 'opened receipt');
});

test('a locked message needs the password and is never saved readable', async () => {
  const { a, b } = await pair();
  const sent = a.sendText(b.id, 'launch code 1234', { password: 'tiger' });
  await waitFor(() => sent.status === 'delivered', 'ack');
  const [received] = incoming(b, a.id);
  assert.equal(received.text, '');
  assert.throws(() => b.unlockMessage(a.id, received.id, 'wrong'), /Wrong password/);
  assert.equal(sent.readBy, undefined);
  assert.equal(b.unlockMessage(a.id, received.id, 'tiger'), 'launch code 1234');
  assert.equal(a.unlockMessage(b.id, sent.id, 'tiger'), 'launch code 1234');
  await waitFor(() => sent.readBy?.includes(b.id), 'opened receipt');
  a.store.flush();
  b.store.flush();
  assert.ok(!fs.readFileSync(a.store.file, 'utf8').includes('launch code'));
  assert.ok(!fs.readFileSync(b.store.file, 'utf8').includes('launch code'));
});

test('quoted replies carry the original text', async () => {
  const { a, b } = await pair();
  const first = a.sendText(b.id, 'original');
  await waitFor(() => incoming(b, a.id).length === 1, 'first');
  b.sendText(a.id, 'answer', { reply: { id: first.id, name: 'Asha', text: 'original' } });
  await waitFor(() => incoming(a, b.id).length === 1, 'reply');
  assert.deepEqual(incoming(a, b.id)[0].reply, { id: first.id, name: 'Asha', text: 'original' });
});

test('away status shows and auto-replies once per person', async () => {
  const { a, b } = await pair({ away: true, awayText: 'Back at 3pm' });
  await waitFor(() => a.listPeers().find((p) => p.id === b.id).away, 'away status');
  a.sendText(b.id, 'one');
  await waitFor(() => incoming(a, b.id).length === 1, 'auto reply');
  assert.equal(incoming(a, b.id)[0].text, 'Back at 3pm');
  assert.equal(incoming(a, b.id)[0].auto, true);
  a.sendText(b.id, 'two');
  await waitFor(() => incoming(b, a.id).length === 2, 'second message');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(incoming(a, b.id).length, 1);
  b.configure({ away: false });
  await waitFor(() => !a.listPeers().find((p) => p.id === b.id).away, 'back');
});

test('two away people do not reply to each other forever', async () => {
  const { a, b } = await pair({ away: true, awayText: 'B away' });
  a.configure({ away: true, awayText: 'A away' });
  a.sendText(b.id, 'hi');
  await waitFor(() => incoming(a, b.id).length === 1, 'auto reply');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(incoming(a, b.id).length, 1);
  assert.equal(incoming(b, a.id).length, 1);
});

test('images arrive and non-images are refused', async () => {
  const { a, b } = await pair();
  const sent = a.sendImage(b.id, PNG);
  await waitFor(() => sent.status === 'delivered', 'ack');
  const [received] = incoming(b, a.id);
  assert.equal(received.kind, 'image');
  assert.ok(fs.readFileSync(received.image.path).equals(PNG));
  assert.ok(b.imageData(a.id, received.id).startsWith('data:image/png;base64,'));
  assert.throws(() => a.sendImage(b.id, Buffer.from('<svg onload="alert(1)"></svg>')), /not supported/);
  assert.throws(() => a.sendImage(b.id, Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)])), /10 MB/);
  const socket = net.connect({ host: '127.0.0.1', port: b.listenPort });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  const channel = await clientHandshake(socket, a.identity, 'Asha', b.id);
  const fake = Buffer.from('<html>not an image</html>');
  await channel.send({ t: 'image', id: 'fake', size: fake.length });
  await channel.sendBinary(fake);
  await channel.send({ t: 'image-end', sha256: crypto.createHash('sha256').update(fake).digest('hex') });
  await assert.rejects(channel.recv());
  assert.equal(incoming(b, a.id).length, 1);
  channel.destroy();
});
