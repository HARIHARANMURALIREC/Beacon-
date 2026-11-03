'use strict';
// Authenticated, encrypted framing over TCP.
// Handshake: ephemeral X25519 key exchange, with both sides signing the transcript
// using their long-term Ed25519 device key. Frames: AES-256-GCM with counter nonces.
const crypto = require('crypto');

const MAX_HANDSHAKE_FRAME = 8 * 1024;
const MAX_FRAME = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10000;
const TYPE_JSON = 0;
const TYPE_BINARY = 1;

function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function idFromPublicKey(publicKeyB64) {
  return crypto.createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 32);
}

function loadPublic(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), type: 'spki', format: 'der' });
}

class FramedSocket {
  constructor(socket, maxFrame = MAX_HANDSHAKE_FRAME) {
    this.socket = socket;
    this.maxFrame = maxFrame;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.error = null;
    socket.on('data', (data) => this.onData(data));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection closed')));
  }

  onData(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maxFrame) {
        this.fail(new Error('frame too large'));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < 4 + length) break;
      const frame = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.queue.push(frame);
    }
    if (this.queue.length > 32) this.socket.pause();
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }

  read() {
    if (this.queue.length) {
      const frame = this.queue.shift();
      if (this.queue.length < 8 && this.socket.isPaused()) this.socket.resume();
      return Promise.resolve(frame);
    }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  write(payload) {
    if (this.error) return Promise.reject(this.error);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.concat([header, payload]), (err) => (err ? reject(err) : resolve()));
    });
  }
}

class SecureChannel {
  constructor(framed, sendKey, recvKey, remote) {
    this.framed = framed;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.remote = remote; // { id, publicKey, name }
    this.sendCounter = 0n;
    this.recvCounter = 0n;
    framed.maxFrame = MAX_FRAME + 64;
  }

  static nonce(counter) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(counter, 4);
    return nonce;
  }

  async sendFrame(type, payload) {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, SecureChannel.nonce(this.sendCounter++));
    const body = Buffer.concat([cipher.update(Buffer.from([type])), cipher.update(payload), cipher.final()]);
    await this.framed.write(Buffer.concat([body, cipher.getAuthTag()]));
  }

  send(obj) {
    return this.sendFrame(TYPE_JSON, Buffer.from(JSON.stringify(obj)));
  }

  sendBinary(buffer) {
    return this.sendFrame(TYPE_BINARY, buffer);
  }

  // Resolves to a parsed object, or a Buffer for binary frames.
  async recv() {
    const frame = await this.framed.read();
    if (frame.length < 17) throw new Error('short frame');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, SecureChannel.nonce(this.recvCounter++));
    decipher.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([decipher.update(frame.subarray(0, frame.length - 16)), decipher.final()]);
    const body = plain.subarray(1);
    return plain[0] === TYPE_BINARY ? body : JSON.parse(body.toString());
  }

  close() {
    this.framed.socket.end();
  }

  destroy() {
    this.framed.socket.destroy();
  }
}

function transcriptHash(clientHello, serverHello) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([clientHello.eph, clientHello.pub, serverHello.eph, serverHello.pub]))
    .digest();
}

function deriveKeys(myEphemeral, theirEphB64, transcript) {
  const secret = crypto.diffieHellman({ privateKey: myEphemeral.privateKey, publicKey: loadPublic(theirEphB64) });
  const keys = Buffer.from(crypto.hkdfSync('sha256', secret, transcript, 'beacon v1', 64));
  return { clientToServer: keys.subarray(0, 32), serverToClient: keys.subarray(32, 64) };
}

function sign(identity, label, transcript) {
  return crypto.sign(null, Buffer.concat([Buffer.from(label), transcript]), identity.privateKey).toString('base64');
}

function verify(publicKeyB64, label, transcript, signature) {
  return crypto.verify(
    null,
    Buffer.concat([Buffer.from(label), transcript]),
    loadPublic(publicKeyB64),
    Buffer.from(String(signature), 'base64')
  );
}

function newEphemeral() {
  const pair = crypto.generateKeyPairSync('x25519');
  return { ...pair, b64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function parseHello(frame) {
  const hello = JSON.parse(frame.toString());
  if (hello.v !== 1 || typeof hello.eph !== 'string' || typeof hello.pub !== 'string') {
    throw new Error('bad hello');
  }
  return hello;
}

function withTimeout(socket, promise) {
  const timer = setTimeout(() => socket.destroy(new Error('handshake timed out')), HANDSHAKE_TIMEOUT_MS);
  return promise.finally(() => clearTimeout(timer));
}

// expectedId must match the peer's key, which stops another device answering for that peer.
function clientHandshake(socket, identity, name, expectedId) {
  const framed = new FramedSocket(socket);
  return withTimeout(socket, (async () => {
    const eph = newEphemeral();
    const clientHello = { v: 1, eph: eph.b64, pub: identity.publicKey, name };
    await framed.write(Buffer.from(JSON.stringify(clientHello)));
    const serverHello = parseHello(await framed.read());
    if (idFromPublicKey(serverHello.pub) !== expectedId) throw new Error('peer identity mismatch');
    const transcript = transcriptHash(clientHello, serverHello);
    if (!verify(serverHello.pub, 'server', transcript, serverHello.sig)) throw new Error('bad server signature');
    const keys = deriveKeys(eph, serverHello.eph, transcript);
    const channel = new SecureChannel(framed, keys.clientToServer, keys.serverToClient, {
      id: expectedId,
      publicKey: serverHello.pub,
      name: serverHello.name,
    });
    await channel.send({ sig: sign(identity, 'client', transcript) });
    return channel;
  })());
}

function serverHandshake(socket, identity, name) {
  const framed = new FramedSocket(socket);
  return withTimeout(socket, (async () => {
    const clientHello = parseHello(await framed.read());
    const eph = newEphemeral();
    const serverHello = { v: 1, eph: eph.b64, pub: identity.publicKey, name };
    const transcript = transcriptHash(clientHello, serverHello);
    serverHello.sig = sign(identity, 'server', transcript);
    await framed.write(Buffer.from(JSON.stringify(serverHello)));
    const keys = deriveKeys(eph, clientHello.eph, transcript);
    const channel = new SecureChannel(framed, keys.serverToClient, keys.clientToServer, {
      id: idFromPublicKey(clientHello.pub),
      publicKey: clientHello.pub,
      name: clientHello.name,
    });
    const finish = await channel.recv();
    if (!verify(clientHello.pub, 'client', transcript, finish.sig)) throw new Error('bad client signature');
    return channel;
  })());
}

module.exports = { createIdentity, idFromPublicKey, clientHandshake, serverHandshake, MAX_FRAME };
