'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_MANIFEST = 64 * 1024;
const MAX_UPDATE = 1024 * 1024 * 1024;

function compareVersions(a, b) {
  const parts = (value) => String(value).split('.').map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
  }
  return 0;
}

// Throws unless the manifest was signed by the update key and its contents are well formed.
function readManifest(text, publicKey) {
  const { payload, signature } = JSON.parse(text);
  if (typeof payload !== 'string' || typeof signature !== 'string') throw new Error('Update details are malformed');
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' });
  if (!crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64'))) {
    throw new Error('Update signature is not valid');
  }
  const manifest = JSON.parse(Buffer.from(payload, 'base64').toString());
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || typeof manifest.files !== 'object') {
    throw new Error('Update details are malformed');
  }
  return manifest;
}

function checkFileEntry(entry) {
  const valid = entry && /^[\w.-]+$/.test(entry.name) && !entry.name.startsWith('.') && /^[a-f0-9]{64}$/.test(entry.sha256)
    && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MAX_UPDATE;
  if (!valid) throw new Error('Update details are malformed');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

class Updater extends EventEmitter {
  constructor({ currentVersion, platform, feedUrl, publicKey, dir }) {
    super();
    Object.assign(this, { currentVersion, platform, feedUrl, publicKey, dir });
    this.state = { status: 'idle', currentVersion };
    this.running = false;
  }

  setState(state) {
    this.state = { currentVersion: this.currentVersion, ...state };
    this.emit('state', this.state);
    return this.state;
  }

  async check() {
    if (this.running || this.state.status === 'ready') return this.state;
    this.running = true;
    try {
      this.setState({ status: 'checking' });
      const response = await fetch(new URL('update.json', this.feedUrl));
      // A release without update details simply means there's nothing to install.
      if (response.status === 404) return this.setState({ status: 'current' });
      if (!response.ok) throw new Error(`Update check failed (${response.status})`);
      const text = await response.text();
      if (text.length > MAX_MANIFEST) throw new Error('Update details are malformed');
      const manifest = readManifest(text, this.publicKey);
      const entry = manifest.files[this.platform];
      // Refusing older versions stops anyone replaying an old release with known bugs.
      if (compareVersions(manifest.version, this.currentVersion) <= 0 || !entry) return this.setState({ status: 'current' });
      checkFileEntry(entry);
      const file = await this.download(manifest.version, entry);
      this.setState({ status: 'ready', version: manifest.version, file });
    } catch (err) {
      this.setState({ status: 'error', error: err.message });
    } finally {
      this.running = false;
    }
    return this.state;
  }

  async download(version, entry) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, entry.name);
    await this.removeOthers(entry.name);
    if (fs.existsSync(target) && (await sha256File(target)) === entry.sha256) return target;
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      const response = await fetch(new URL(entry.name, this.feedUrl));
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastEmit = 0;
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => {
        received += chunk.length;
        if (received > entry.size) source.destroy(new Error('Download is larger than expected'));
        hash.update(chunk);
        if (Date.now() - lastEmit > 500) {
          lastEmit = Date.now();
          this.setState({ status: 'downloading', version, percent: Math.round((received / entry.size) * 100) });
        }
      });
      await pipeline(source, fs.createWriteStream(temp, { mode: 0o600 }));
      if (received !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Download did not match its signature');
      await fs.promises.rename(temp, target);
      return target;
    } catch (err) {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async removeOthers(keep) {
    for (const name of await fs.promises.readdir(this.dir)) {
      if (name !== keep) await fs.promises.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { Updater, compareVersions, readManifest };
