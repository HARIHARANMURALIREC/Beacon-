'use strict';
const EVERYONE = 'everyone';
// A LAN can finish a small file in milliseconds. Hold the animation long enough to be seen.
const MIN_TRANSFER_DISPLAY_MS = 1100;
const $ = (id) => document.getElementById(id);

let settings = {};
let peers = [];
let messages = {};
let groups = {};
let unread = {};
let active = null;
let replyTo = null;
let composeMode = null;
let composePassword = null;
const opened = new Map();

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
const ICON_FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const ICON_SEAL = 'M4 6h16v12H4zM4 7l8 6 8-6';
const ICON_LOCK = 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3';
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
  node.textContent = id === EVERYONE ? 'All' : initials(name);
  node.classList.toggle('group', id === EVERYONE || isGroup(id));
  node.style.setProperty('--hue', hueFor(id));
}

function avatar(id, name) {
  const node = el('span', 'avatar');
  setAvatar(node, id, name);
  return node;
}

function isGroup(id) {
  return String(id).startsWith('g:');
}

function conversationName(id) {
  if (id === EVERYONE) return 'Everyone';
  return isGroup(id) ? (groups[id] || {}).name || 'Group' : nameOf(id);
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
  let body = last.kind === 'file' ? last.file.name : last.kind === 'image' ? 'Image' : (last.text || '').split('\n')[0];
  if (last.locked) body = 'Locked message';
  else if (last.sealed && last.dir === 'in' && !last.opened) body = 'Sealed message';
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
  for (const group of Object.values(groups)) {
    if (!group.name.toLowerCase().includes(query)) continue;
    const count = `${group.members.length} people`;
    list.append(personButton(group.id, group.name, preview(group.id) || count, group.members.some((id) => peers.find((p) => p.id === id)?.online)));
  }
  const matching = peers.filter((peer) => peer.name.toLowerCase().includes(query));
  let heading = null;
  for (const peer of sortPeers(matching)) {
    if (settings.sort === 'group' && (peer.group || 'No group') !== heading) {
      heading = peer.group || 'No group';
      list.append(el('p', 'list-heading', heading));
    }
    const status = peer.away ? 'Away' : peer.online ? 'Online' : 'Offline';
    const detail = settings.sort === 'ip' && peer.ip ? peer.ip : preview(peer.id) || status;
    const button = personButton(peer.id, peer.name, detail, peer.online);
    if (peer.away) button.querySelector('.dot').classList.add('away');
    list.append(button);
  }
  if (query.length >= 2) renderSearchResults(list, query);
  if (!peers.length) {
    list.append(el('p', 'section-note', 'No one found yet. Ask a colleague on this network to open Beacon, or check Settings if they are on another subnet.'));
  }
  list.scrollTop = scroll;
}

function ipValue(ip) {
  return ip ? ip.split('.').reduce((total, part) => total * 256 + Number(part), 0) : Infinity;
}

function sortPeers(list) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const online = (a, b) => Number(b.online) - Number(a.online);
  if (settings.sort === 'group') {
    return [...list].sort((a, b) => (a.group || '\uffff').localeCompare(b.group || '\uffff') || online(a, b) || byName(a, b));
  }
  if (settings.sort === 'ip') return [...list].sort((a, b) => ipValue(a.ip) - ipValue(b.ip) || byName(a, b));
  return [...list].sort((a, b) => online(a, b) || byName(a, b));
}

// Unopened sealed and locked messages stay out of search, so it can't reveal them.
function searchableText(message) {
  if (message.kind === 'file') return message.file.name;
  if (message.kind !== 'text' || message.locked) return '';
  if (message.sealed && message.dir === 'in' && !message.opened) return '';
  return message.text;
}

function renderSearchResults(list, query) {
  const results = [];
  for (const [conv, items] of Object.entries(messages)) {
    for (const message of items) {
      if (searchableText(message).toLowerCase().includes(query)) results.push({ conv, message });
    }
  }
  results.sort((a, b) => b.message.ts - a.message.ts);
  list.append(el('p', 'list-heading', results.length ? 'Messages' : 'No messages found'));
  for (const { conv, message } of results.slice(0, 50)) {
    const row = el('button', 'result');
    row.type = 'button';
    row.append(el('b', '', `${conversationName(conv)} · ${formatDay(message.ts)}`), el('span', '', searchableText(message)));
    row.addEventListener('click', async () => {
      await openConversation(conv);
      const target = rows.get(message.id);
      if (target) {
        target.row.scrollIntoView({ block: 'center' });
        target.row.classList.add('flash');
      }
    });
    list.append(row);
  }
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
  const oneToOne = active !== EVERYONE && !isGroup(active);
  $('attach').disabled = !oneToOne;
  $('attach').title = oneToOne ? 'Send files or a folder' : 'Files and folders can only be sent to one person';
  setAvatar($('chat-avatar'), active, conversationName(active));
  if (isGroup(active)) {
    const group = groups[active] || { members: [] };
    $('chat-title').textContent = group.name;
    $('chat-detail').textContent = group.members.map(nameOf).join(', ');
    $('warning').hidden = true;
    return;
  }
  if (active === EVERYONE) {
    $('chat-title').textContent = 'Everyone';
    $('chat-detail').textContent = 'Sent to everyone online right now. People who are offline will not receive it.';
    $('warning').hidden = true;
    return;
  }
  $('chat-title').textContent = peer ? peer.name : 'Unknown';
  const place = peer && peer.away ? `Away at ${peer.ip}` : peer && peer.online ? `Online at ${peer.ip}` : 'Offline: messages send when they return and you are both running the app';
  $('chat-detail').textContent = `${place} · ID ${fingerprint(active)}`;
  const duplicate = peer && peer.duplicateName;
  $('warning').hidden = !duplicate;
  $('warning').textContent = duplicate
    ? `More than one device uses the name "${peer.name}". Check that ID ${fingerprint(active)} is the right person before sharing anything sensitive.`
    : '';
}

function statusText(message) {
  const time = formatClock(message.ts);
  if (message.dir === 'in') return message.conv === EVERYONE || isGroup(message.conv) ? `${message.fromName} · ${time}` : time;
  const readVerb = message.sealed ? 'Opened' : 'Read';
  const readers = (message.readBy || []).length;
  if (message.recipients) {
    const total = message.recipients.length;
    if (readers) return `${time} · ${readVerb} by ${readers} of ${total}`;
    return `${time} · Delivered to ${total - (message.pending || []).length} of ${total}`;
  }
  if (readers) return `${time} · ${readVerb}`;
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

function fileSummary(file) {
  if (!file.folder) return formatSize(file.size);
  return `${file.count === 1 ? '1 file' : `${file.count} files`}, ${formatSize(file.size)}`;
}

function drawMoving(card, message) {
  const { file } = message;
  const sender = message.from;
  const receiver = message.dir === 'in' ? settings.id : message.conv;
  const verb = message.dir === 'in' ? 'Receiving' : 'Sending';
  card.append(fileHead(message, fileIcon(file.folder ? ICON_FOLDER : ICON_FILE), `${fileSummary(file)} · ${verb}`));
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
    card.append(fileHead(message, check, `${fileSummary(file)} · ${message.dir === 'in' ? 'Saved' : 'Sent'}`));
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
      offered: message.dir === 'in' ? (settings.autoAccept ? 'Waiting to download' : 'Waiting for you to accept') : 'Waiting to send',
      declined: 'Declined',
    };
    card.append(fileHead(message, fileIcon(file.folder ? ICON_FOLDER : ICON_FILE), `${fileSummary(file)} · ${labels[phase] || phase}`));
  }
  if (message.dir === 'in' && ((phase === 'offered' && !settings.autoAccept) || phase === 'failed')) {
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

function sealedCard(message, iconPath, title, detail, actionLabel, action) {
  const card = el('div', 'sealed-card');
  const text = el('div', 'sealed-text');
  text.append(el('b', '', title), el('span', 'muted', detail));
  card.append(icon(iconPath), text, button('primary small', actionLabel, action));
  return card;
}

function textBubble(message, text) {
  const bubble = el('div', 'bubble');
  if (message.auto) bubble.append(el('span', 'auto-label', 'Automatic reply'));
  if (message.reply) {
    const quote = el('span', 'quote');
    quote.append(el('b', '', message.reply.name), el('span', '', message.reply.text));
    bubble.append(quote);
  }
  bubble.append(document.createTextNode(text));
  return bubble;
}

function imageBody(message) {
  const box = el('div', 'image-message');
  const image = el('img');
  image.alt = message.dir === 'in' ? `Image from ${message.fromName}` : 'Image you sent';
  box.append(image);
  window.messenger.imageData(message.conv, message.id).then((data) => {
    image.src = data;
  }).catch(() => box.replaceChildren(el('span', 'muted', 'Image is no longer available')));
  return box;
}

function messageBody(message) {
  if (message.kind === 'image') return imageBody(message);
  if (message.locked) {
    if (opened.has(message.id)) return textBubble(message, opened.get(message.id));
    return sealedCard(message, ICON_LOCK, 'Locked message', 'Needs a password', 'Unlock', () => unlockFlow(message));
  }
  if (message.sealed && message.dir === 'in' && !message.opened) {
    const open = () => act(window.messenger.openSealed(message.conv, message.id));
    return sealedCard(message, ICON_SEAL, 'Sealed message', 'The sender is told when you open it', 'Open', open);
  }
  return textBubble(message, message.text);
}

function canReply(message) {
  if (message.kind !== 'text' || message.auto) return false;
  if (message.locked) return opened.has(message.id);
  return !message.sealed || message.dir === 'out' || Boolean(message.opened);
}

function rowActions(message) {
  const actions = el('div', 'message-actions');
  if (canReply(message)) {
    actions.append(button('', 'Reply', () => {
      const text = message.locked ? opened.get(message.id) : message.text;
      replyTo = { id: message.id, name: message.dir === 'out' ? settings.name : message.fromName, text: text.slice(0, 200) };
      renderReplyBar();
      $('text').focus();
    }));
  }
  if (message.kind === 'image') {
    actions.append(button('', 'Show in folder', () => act(window.messenger.showFile(message.conv, message.id))));
  }
  return actions;
}

function renderReplyBar() {
  $('reply-bar').hidden = !replyTo;
  if (replyTo) {
    $('reply-name').textContent = replyTo.name;
    $('reply-text').textContent = replyTo.text;
  }
}

function rowSignature(message) {
  return `${Boolean(message.opened)}:${opened.has(message.id)}`;
}

function buildRow(message, fresh) {
  const row = el('div', `message ${message.dir}`);
  if (fresh) row.classList.add('fresh');
  const meta = el('div', 'meta', statusText(message));
  if (message.kind === 'file') {
    const card = el('div', 'transfer');
    row.append(card, meta);
    syncCard(card, message, fresh);
  } else {
    row.append(messageBody(message), rowActions(message), meta);
  }
  rows.set(message.id, { row, meta, signature: rowSignature(message) });
  return row;
}

// Opening or unlocking changes what a row shows. File cards update in place to keep their animation.
function refreshRow(message) {
  const entry = rows.get(message.id);
  entry.meta.textContent = statusText(message);
  if (message.kind === 'file') {
    syncCard(entry.row.querySelector('.transfer'), message, true);
  } else if (entry.signature !== rowSignature(message)) {
    entry.row.replaceChildren(messageBody(message), rowActions(message), entry.meta);
    entry.signature = rowSignature(message);
  }
}

async function unlockFlow(message) {
  const text = await promptPassword({
    title: 'Unlock message',
    hint: message.dir === 'in' ? `Ask ${message.fromName} for the password if you don't have it.` : '',
    confirm: 'Unlock',
    check: (password) => window.messenger.unlock(message.conv, message.id, password),
  });
  if (text === null) return;
  opened.set(message.id, text);
  refreshRow(message);
}

let passwordRequest = null;

function promptPassword({ title, hint, confirm, check }) {
  $('password-title').textContent = title;
  $('password-hint').textContent = hint;
  $('password-confirm').textContent = confirm;
  $('password-input').value = '';
  $('password-error').hidden = true;
  $('password-dialog').showModal();
  return new Promise((resolve) => {
    passwordRequest = { check, resolve };
  });
}

function closePassword(value) {
  $('password-dialog').close();
  const request = passwordRequest;
  passwordRequest = null;
  if (request) request.resolve(value);
}

function setComposeMode(mode, password = null) {
  composeMode = mode;
  composePassword = password;
  $('seal').setAttribute('aria-pressed', String(mode === 'sealed'));
  $('lock').setAttribute('aria-pressed', String(mode === 'locked'));
  $('text').placeholder = mode === 'locked' ? 'Write a locked message' : mode === 'sealed' ? 'Write a sealed message' : 'Write a message';
}

function openGroupDialog() {
  const list = $('group-people');
  list.replaceChildren();
  for (const peer of sortPeers(peers)) {
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.value = peer.id;
    label.append(box, document.createTextNode(peer.online ? peer.name : `${peer.name} (offline)`));
    list.append(label);
  }
  if (!peers.length) list.append(el('p', 'section-note', 'No one to add yet.'));
  $('group-name').value = '';
  $('group-error').hidden = true;
  $('group-dialog').showModal();
}

async function saveGroup(event) {
  event.preventDefault();
  const members = [...$('group-people').querySelectorAll('input:checked')].map((box) => box.value);
  try {
    const id = await window.messenger.createGroup($('group-name').value, members);
    $('group-dialog').close();
    groups[id] = groups[id] || { id, name: $('group-name').value, members: [settings.id, ...members] };
    openConversation(id);
  } catch (err) {
    $('group-error').textContent = cleanError(err);
    $('group-error').hidden = false;
  }
}

function sendFromClipboard(event) {
  const files = [...event.clipboardData.files];
  if (!files.length || !active) return;
  event.preventDefault();
  for (const file of files) {
    const filePath = window.messenger.pathForFile(file);
    if (filePath) act(window.messenger.sendPaths(active, [filePath]));
    else if (file.type.startsWith('image/')) act(file.arrayBuffer().then((data) => window.messenger.sendImage(active, data)));
    else showError('That item cannot be sent. Save it as a file first.');
  }
}

function setupDragAndDrop() {
  let depth = 0;
  const hasFiles = (event) => [...event.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event) || !active) return;
    depth += 1;
    $('drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $('drop-overlay').hidden = true;
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    $('drop-overlay').hidden = true;
    if (!active) return;
    const paths = [...event.dataTransfer.files].map((file) => window.messenger.pathForFile(file)).filter(Boolean);
    if (paths.length) act(window.messenger.sendPaths(active, paths));
  });
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
    if (rows.has(message.id)) {
      refreshRow(message);
    } else {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      appendWithDay(container, message, previous, true);
      if (atBottom || message.dir === 'out') container.scrollTop = container.scrollHeight;
    }
  }
  if (index < 0 || message.opened) renderPeople();
}

async function openConversation(id) {
  if (active !== id) {
    replyTo = null;
    setComposeMode(null);
    renderReplyBar();
  }
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
  const options = { reply: replyTo || undefined, sealed: composeMode === 'sealed', password: composePassword || undefined };
  act(window.messenger.sendText(active, text, options).then(() => {
    $('text').value = '';
    replyTo = null;
    setComposeMode(null);
    renderReplyBar();
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
  $('set-group').value = settings.group;
  $('set-away').checked = settings.away;
  $('set-away-text').value = settings.awayText;
  $('set-arrival').value = settings.arrival;
  $('set-auto').checked = settings.autoAccept;
  $('set-receipts').checked = settings.readReceipts;
  $('settings-error').hidden = true;
  $('settings').showModal();
}

function settingsForm() {
  return {
    name: $('set-name').value,
    downloadDir: $('set-folder').value,
    targets: $('set-targets').value,
    openAtLogin: $('set-login').checked,
    group: $('set-group').value,
    away: $('set-away').checked,
    awayText: $('set-away-text').value,
    arrival: $('set-arrival').value,
    autoAccept: $('set-auto').checked,
    readReceipts: $('set-receipts').checked,
  };
}

let updateState = { status: 'idle' };

function updateStatusText(state) {
  if (state.status === 'checking') return ' · Checking for updates';
  if (state.status === 'current') return ' · Up to date';
  if (state.status === 'downloading') return ` · Downloading ${state.version} (${state.percent}%)`;
  if (state.status === 'ready') return ` · ${state.version} is ready`;
  if (state.status === 'error') return ' · Could not check for updates';
  return '';
}

function renderUpdate() {
  const state = updateState;
  $('set-version').textContent = `Beacon ${state.currentVersion || ''}`;
  $('set-update-status').textContent = updateStatusText(state);
  $('check-updates').disabled = ['checking', 'downloading', 'ready'].includes(state.status);
  // Failed background checks stay out of the way, as being offline is normal.
  const show = state.status === 'ready' || state.status === 'downloading' || Boolean(state.installError);
  $('update-banner').hidden = !show;
  if (!show) return;
  const action = $('update-action');
  if (state.installError) {
    $('update-title').textContent = 'Update could not be installed';
    $('update-detail').textContent = state.installError;
    action.hidden = false;
    action.textContent = 'Download';
  } else if (state.status === 'ready') {
    $('update-title').textContent = `Beacon ${state.version} is ready`;
    $('update-detail').textContent = 'Restart to finish updating';
    action.hidden = false;
    action.textContent = 'Restart';
  } else {
    $('update-title').textContent = `Downloading Beacon ${state.version}`;
    $('update-detail').textContent = `${state.percent}%`;
    action.hidden = true;
  }
}

$('update-action').addEventListener('click', async () => {
  if (updateState.installError) {
    window.messenger.openReleases();
    return;
  }
  $('update-action').disabled = true;
  try {
    await window.messenger.installUpdate();
  } catch (err) {
    updateState = { ...updateState, installError: cleanError(err) };
    renderUpdate();
  } finally {
    $('update-action').disabled = false;
  }
});
$('check-updates').addEventListener('click', () => window.messenger.checkUpdates());
window.messenger.onUpdateState((state) => {
  updateState = state;
  renderUpdate();
});

function renderMe() {
  $('my-name').textContent = settings.name;
  $('sort').value = settings.sort;
  setAvatar($('my-avatar'), settings.id, settings.name);
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    settings = await window.messenger.saveSettings(settingsForm());
    renderMe();
    renderPeople();
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
$('text').addEventListener('paste', sendFromClipboard);
$('attach').addEventListener('click', (event) => {
  event.stopPropagation();
  $('attach-menu').hidden = !$('attach-menu').hidden;
});
document.addEventListener('click', () => {
  $('attach-menu').hidden = true;
});
$('attach-files').addEventListener('click', () => act(window.messenger.pickAndSend(active, 'files')));
$('attach-folder').addEventListener('click', () => act(window.messenger.pickAndSend(active, 'folder')));
$('seal').addEventListener('click', () => setComposeMode(composeMode === 'sealed' ? null : 'sealed'));
$('lock').addEventListener('click', async () => {
  if (composeMode === 'locked') {
    setComposeMode(null);
    return;
  }
  const password = await promptPassword({
    title: 'Lock this message',
    hint: 'Share the password with them another way. Beacon cannot recover it.',
    confirm: 'Use password',
    check: async (value) => value,
  });
  if (password) setComposeMode('locked', password);
  $('text').focus();
});
$('reply-cancel').addEventListener('click', () => {
  replyTo = null;
  renderReplyBar();
});
$('sort').addEventListener('change', async () => {
  settings = await window.messenger.saveSettings({ ...settings, targets: settings.targets.join(', '), sort: $('sort').value });
  renderPeople();
});
$('new-group').addEventListener('click', openGroupDialog);
$('cancel-group').addEventListener('click', () => $('group-dialog').close());
$('group-form').addEventListener('submit', saveGroup);
$('cancel-password').addEventListener('click', () => closePassword(null));
$('password-dialog').addEventListener('cancel', () => closePassword(null));
$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    closePassword(await passwordRequest.check($('password-input').value));
  } catch (err) {
    $('password-error').textContent = cleanError(err);
    $('password-error').hidden = false;
  }
});
setupDragAndDrop();
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
window.messenger.onGroups((next) => {
  groups = next;
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
  ({ settings, peers, messages, groups, unread } = state);
  updateState = state.update;
  renderUpdate();
  renderMe();
  renderPeople();
});
