'use strict';
const fs = require('fs');
const path = require('path');

const MAX_MESSAGES_PER_CONVERSATION = 2000;

// JSON state on disk. Writes are debounced and atomic (temp file, then rename).
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.identityFile = path.join(dir, 'identity.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { messages: {}, offers: {}, peers: {} };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep an unreadable file for support rather than overwriting it.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
    this.timer = null;
  }

  loadOrCreateIdentity(create) {
    try {
      return JSON.parse(fs.readFileSync(this.identityFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const identity = create();
    fs.writeFileSync(this.identityFile, JSON.stringify(identity), { mode: 0o600 });
    return identity;
  }

  conversation(id) {
    if (!this.data.messages[id]) this.data.messages[id] = [];
    return this.data.messages[id];
  }

  addMessage(message) {
    const list = this.conversation(message.conv);
    list.push(message);
    if (list.length > MAX_MESSAGES_PER_CONVERSATION) list.shift();
    this.save();
  }

  findMessage(conv, id) {
    return (this.data.messages[conv] || []).find((message) => message.id === id);
  }

  allMessages() {
    return Object.values(this.data.messages).flat();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, 200);
  }

  writeNow() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.writeNow();
  }
}

module.exports = { Store };
