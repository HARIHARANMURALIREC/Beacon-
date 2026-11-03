'use strict';
const EVERYONE = 'everyone';
// A LAN can finish a small file in milliseconds. Hold the animation long enough to be seen.
const MIN_TRANSFER_DISPLAY_MS = 1100;
const $ = (id) => document.getElementById(id);

let settings = {};
let peers = [];
let messages = {};
let unread = {};
let active = null;

const rows = new Map();
const transfers = new Map();

if (window.messenger.platform === 'darwin') document.body.classList.add('mac');

// All names, messages and file names come from other people, so they're only ever set as text.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(pathData) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

const ICON_FILE = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5';
const ICON_CHECK = 'm5 12.5 4.5 4.5L19 7.5';
const ICON_ALERT = 'M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z';

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function hueFor(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function setAvatar(node, id, name) {
  node.textContent = id === EVERYONE ? '' : initials(name);
  node.classList.toggle('group', id === EVERYONE);
  if (id === EVERYONE) node.textContent = 'All';
  node.style.setProperty('--hue', hueFor(id));
}

function avatar(id, name) {
  const node = el('span', 'avatar');
  setAvatar(node, id, name);
  return node;
}

function nameOf(id) {
  if (id === settings.id) return settings.name;
  const peer = peers.find((item) => item.id === id);
  return peer ? peer.name : 'Unknown';
}

function fingerprint(id) {
  return id.slice(0, 12).match(/.{4}/g).join(' ');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

function cleanError(err) {
  // Electron prefixes IPC errors with the channel name, which means nothing to users.
  return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function act(promise) {
  showError('');
  return promise.catch((err) => showError(cleanError(err)));
}

function preview(id) {
  const list = messages[id];
  const last = list && list[list.length - 1];
  if (!last) return null;
  const body = last.kind === 'file' ? last.file.name : last.text.split('\n')[0];
  return last.dir === 'out' ? `You: ${body}` : body;
}

function renderPeople() {
  const query = $('search').value.trim().toLowerCase();
  const list = $('people');
  const scroll = list.scrollTop;
  list.replaceChildren();
  const online = peers.filter((peer) => peer.online).length;
  $('my-status').textContent = online === 1 ? '1 colleague online' : `${online} colleagues online`;
  if (!query || 'everyone'.includes(query)) {
    list.append(personButton(EVERYONE, 'Everyone', preview(EVERYONE) || `${online} online`, online > 0));
  }
  const sorted = peers
    .filter((peer) => peer.name.toLowerCase().includes(query))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  for (const peer of sorted) {
    list.append(personButton(peer.id, peer.name, preview(peer.id) || (peer.online ? 'Online' : 'Offline'), peer.online));
  }
  if (!peers.length) {
    list.append(el('p', 'section-note', 'No one found yet. Ask a colleague on this network to open Beacon, or check Settings if they are on another subnet.'));
  }
  list.scrollTop = scroll;
}

function personButton(id, name, subtitle, online) {
  const button = el('button', 'person');
  button.type = 'button';
  if (id === active) button.setAttribute('aria-current', 'true');
  const face = avatar(id, name);
  face.append(el('span', online ? 'dot online' : 'dot'));
  const text = el('span', 'person-text');
  text.append(el('span', 'person-name', name), el('span', 'muted person-preview', subtitle));
  button.append(face, text);
  if (unread[id]) button.append(el('span', 'badge', String(unread[id])));
  button.addEventListener('click', () => openConversation(id));
  return button;
}

function renderHeader() {
  const peer = peers.find((item) => item.id === active);
  $('attach').disabled = active === EVERYONE;
  $('attach').title = active === EVERYONE ? 'Files can only be sent to one person' : 'Send file';
  setAvatar($('chat-avatar'), active, active === EVERYONE ? 'Everyone' : nameOf(active));
  if (active === EVERYONE) {
    $('chat-title').textContent = 'Everyone';
    $('chat-detail').textContent = 'Sent to everyone online right now. People who are offline will not receive it.';
    $('warning').hidden = true;
    return;
  }
  $('chat-title').textContent = peer ? peer.name : 'Unknown';
  const place = peer && peer.online ? `Online at ${peer.ip}` : 'Offline: messages send when they return and you are both running the app';
  $('chat-detail').textContent = `${place} · ID ${fingerprint(active)}`;
  const duplicate = peer && peer.duplicateName;
  $('warning').hidden = !duplicate;
  $('warning').textContent = duplicate
    ? `More than one device uses the name "${peer.name}". Check that ID ${fingerprint(active)} is the right person before sharing anything sensitive.`
    : '';
}

function statusText(message) {
  const time = formatClock(message.ts);
  if (message.dir === 'in') return message.conv === EVERYONE ? `${message.fromName} · ${time}` : time;
  if (message.recipients) {
    const delivered = message.recipients.length - (message.pending || []).length;
    return `${time} · Delivered to ${delivered} of ${message.recipients.length}`;
  }
  return `${time} · ${message.status === 'delivered' ? 'Delivered' : 'Waiting to send'}`;
}

// ---- File transfer card ----

function phaseOf(file) {
  return ['receiving', 'sending'].includes(file.state) ? 'moving' : file.state;
}

function fileHead(message, leading, detail) {
  const head = el('div', 'transfer-head');
  const text = el('div', 'file-text');
  text.append(el('div', 'file-name', message.file.name), el('div', 'muted', detail));
  head.append(leading, text);
  return head;
}

function fileIcon(path) {
  const box = el('span', 'file-icon');
  box.append(icon(path));
  return box;
}

function button(className, label, handler) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function drawMoving(card, message) {
  const { file } = message;
  const sender = message.from;
  const receiver = message.dir === 'in' ? settings.id : message.conv;
  const verb = message.dir === 'in' ? 'Receiving' : 'Sending';
  card.append(fileHead(message, fileIcon(ICON_FILE), `${formatSize(file.size)} · ${verb}`));
  const beam = el('div', 'beam');
  const end = avatar(receiver, nameOf(receiver));
  end.classList.add('receiving-end');
  const track = el('div', 'track');
  const fill = el('div', 'track-fill');
  track.append(fill);
  beam.append(avatar(sender, nameOf(sender)), track, end);
  const stats = el('div', 'beam-stats');
  const percent = el('b', '', '0%');
  const speed = el('span', '', '');
  stats.append(percent, speed);
  card.append(beam, stats);
  return { fill, percent, speed };
}

function updateProgress(entry, message) {
  if (!entry.parts) return;
  const { size, transferred = 0 } = message.file;
  const fraction = size ? Math.min(transferred / size, 1) : 1;
  entry.parts.fill.style.setProperty('--progress', fraction);
  entry.parts.percent.textContent = `${Math.round(fraction * 100)}%`;
  const now = Date.now();
  if (now - entry.speedAt >= 400) {
    const rate = ((transferred - entry.speedBytes) / (now - entry.speedAt)) * 1000;
    if (rate > 0) entry.parts.speed.textContent = `${formatSize(rate)}/s`;
    entry.speedAt = now;
    entry.speedBytes = transferred;
  }
}

function drawCard(card, message, phase, live) {
  const { file } = message;
  const entry = transfers.get(message.id);
  card.replaceChildren();
  card.className = 'transfer';
  entry.parts = null;
  if (phase === 'moving') {
    entry.parts = drawMoving(card, message);
    entry.startedAt = Date.now();
    entry.speedAt = Date.now();
    entry.speedBytes = file.transferred || 0;
    updateProgress(entry, message);
    return;
  }
  if (phase === 'done') {
    const check = el('span', 'check');
    check.append(icon(ICON_CHECK));
    card.append(fileHead(message, check, `${formatSize(file.size)} · ${message.dir === 'in' ? 'Saved' : 'Sent'}`));
    if (live) card.classList.add('just-finished');
    if (message.dir === 'in') {
      const actions = el('div', 'file-actions');
      actions.append(button('ghost', 'Show in folder', () => act(window.messenger.showFile(message.conv, message.id))));
      card.append(actions);
    }
    return;
  }
  if (phase === 'failed') {
    card.classList.add('failed');
    if (live) card.classList.add('just-failed');
    card.append(fileHead(message, fileIcon(ICON_ALERT), `Failed: ${file.error || 'transfer did not finish'}`));
  } else {
    const labels = {
      offered: message.dir === 'in' ? 'Waiting for you to accept' : 'Waiting for them to accept',
      declined: 'Declined',
    };
    card.append(fileHead(message, fileIcon(ICON_FILE), `${formatSize(file.size)} · ${labels[phase] || phase}`));
  }
  if (message.dir === 'in' && (phase === 'offered' || phase === 'failed')) {
    const actions = el('div', 'file-actions');
    actions.append(
      button('primary', phase === 'failed' ? 'Try again' : 'Accept', () => act(window.messenger.acceptFile(message.conv, message.id))),
      button('ghost', 'Decline', () => act(window.messenger.declineFile(message.conv, message.id)))
    );
    card.append(actions);
  }
}

function syncCard(card, message, live) {
  let entry = transfers.get(message.id);
  if (!entry) {
    entry = { phase: null, timer: null, latest: message };
    transfers.set(message.id, entry);
  }
  entry.latest = message;
  entry.card = card;
  const phase = phaseOf(message.file);
  if (entry.timer) return;
  if (phase === entry.phase) {
    if (phase === 'moving') updateProgress(entry, message);
    return;
  }
  if (entry.phase === 'moving' && live) {
    const remaining = MIN_TRANSFER_DISPLAY_MS - (Date.now() - entry.startedAt);
    if (remaining > 0) {
      // Show the bar completing, then reveal the result.
      if (phase === 'done' && entry.parts) {
        entry.parts.fill.style.setProperty('--progress', 1);
        entry.parts.percent.textContent = '100%';
      }
      entry.timer = setTimeout(() => {
        entry.timer = null;
        syncCard(entry.card, entry.latest, true);
      }, remaining);
      return;
    }
  }
  drawCard(card, message, phase, live);
  entry.phase = phase;
}

// ---- Message list ----

function buildRow(message, fresh) {
  const row = el('div', `message ${message.dir}`);
  if (fresh) row.classList.add('fresh');
  if (message.kind === 'file') {
    const card = el('div', 'transfer');
    row.append(card);
    syncCard(card, message, fresh);
  } else {
    row.append(el('div', 'bubble', message.text));
  }
  const meta = el('div', 'meta', statusText(message));
  row.append(meta);
  rows.set(message.id, { row, meta });
  return row;
}

function appendWithDay(container, message, previous, fresh) {
  if (!previous || new Date(previous.ts).toDateString() !== new Date(message.ts).toDateString()) {
    container.append(el('div', 'day', formatDay(message.ts)));
  }
  container.append(buildRow(message, fresh));
}

function renderMessages() {
  const container = $('messages');
  container.replaceChildren();
  rows.clear();
  for (const entry of transfers.values()) clearTimeout(entry.timer);
  transfers.clear();
  let previous = null;
  for (const message of messages[active] || []) {
    appendWithDay(container, message, previous, false);
    previous = message;
  }
  container.scrollTop = container.scrollHeight;
}

// Rows update in place. Rebuilding them would restart every running animation.
function upsertMessage(message) {
  const list = messages[message.conv] || (messages[message.conv] = []);
  const index = list.findIndex((item) => item.id === message.id);
  const previous = index > 0 ? list[index - 1] : list[list.length - 1];
  if (index >= 0) list[index] = message;
  else list.push(message);
  if (message.conv === active) {
    const container = $('messages');
    const existing = rows.get(message.id);
    if (existing) {
      existing.meta.textContent = statusText(message);
      const card = existing.row.querySelector('.transfer');
      if (card) syncCard(card, message, true);
    } else {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      appendWithDay(container, message, previous, true);
      if (atBottom || message.dir === 'out') container.scrollTop = container.scrollHeight;
    }
  }
  if (index < 0) renderPeople();
}

async function openConversation(id) {
  active = id;
  showError('');
  $('empty').hidden = true;
  $('conversation').hidden = false;
  unread = await window.messenger.setActive(id);
  renderPeople();
  renderHeader();
  renderMessages();
  $('text').focus();
}

function submit() {
  const text = $('text').value;
  if (!text.trim() || !active) return;
  act(window.messenger.sendText(active, text).then(() => {
    $('text').value = '';
    resizeComposer();
  }));
}

function resizeComposer() {
  const box = $('text');
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
  box.style.overflowY = box.scrollHeight > 140 ? 'auto' : 'hidden';
}

function openSettings() {
  $('set-name').value = settings.name;
  $('set-folder').value = settings.downloadDir;
  $('set-targets').value = settings.targets.join(', ');
  $('set-login').checked = settings.openAtLogin;
  $('set-id').textContent = settings.id;
  $('settings-error').hidden = true;
  $('settings').showModal();
}

function renderMe() {
  $('my-name').textContent = settings.name;
  setAvatar($('my-avatar'), settings.id, settings.name);
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    settings = await window.messenger.saveSettings({
      name: $('set-name').value,
      downloadDir: $('set-folder').value,
      targets: $('set-targets').value,
      openAtLogin: $('set-login').checked,
    });
    renderMe();
    $('settings').close();
  } catch (err) {
    $('settings-error').textContent = cleanError(err);
    $('settings-error').hidden = false;
  }
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
$('text').addEventListener('input', resizeComposer);
$('text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
$('attach').addEventListener('click', () => act(window.messenger.sendFile(active)));
$('search').addEventListener('input', renderPeople);
$('open-settings').addEventListener('click', openSettings);
$('cancel-settings').addEventListener('click', () => $('settings').close());
$('settings-form').addEventListener('submit', saveSettings);
$('choose-folder').addEventListener('click', async () => {
  const folder = await window.messenger.chooseFolder();
  if (folder) $('set-folder').value = folder;
});

window.messenger.onPeers((next) => {
  peers = next;
  renderPeople();
  if (active) renderHeader();
});
window.messenger.onMessage(upsertMessage);
window.messenger.onUpdated(upsertMessage);
window.messenger.onUnread((next) => {
  unread = next;
  renderPeople();
});
window.messenger.onOpenConversation(openConversation);

window.messenger.state().then((state) => {
  ({ settings, peers, messages, unread } = state);
  renderMe();
  renderPeople();
});
