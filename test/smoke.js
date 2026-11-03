'use strict';
// Drives the real interface. Start two copies with SMOKE_ROLE=sender and SMOKE_ROLE=receiver.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
require('../src/main');

const role = process.env.SMOKE_ROLE;
const out = process.env.SMOKE_OUT;
const peerName = role === 'sender' ? 'Ben Thomas' : 'Asha Rao';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[${role}] ${text}`);
const q = (value) => JSON.stringify(value);
let win;

const run = (code) => win.webContents.executeJavaScript(code);

async function until(expression, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await run(expression)) return log(`ok: ${label}`);
    await sleep(120);
  }
  throw new Error(`timed out: ${label}`);
}

const hasPerson = (name) => `[...document.querySelectorAll('.person')].some((b) => b.textContent.includes(${q(name)}))`;
const clickPerson = (name) => run(`[...document.querySelectorAll('.person')].find((b) => b.textContent.includes(${q(name)})).click()`);
const hasText = (text) => `document.getElementById('messages').textContent.includes(${q(text)})`;
const clickButton = (label) => run(`[...document.querySelectorAll('#messages button')].filter((b) => b.textContent === ${q(label)}).pop().click()`);
const hasButton = (label) => `[...document.querySelectorAll('#messages button')].some((b) => b.textContent === ${q(label)})`;
const send = (text) => run(`document.getElementById('text').value = ${q(text)}; document.getElementById('composer').requestSubmit();`);

async function shot(name) {
  win.show();
  await sleep(300);
  fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
}

// Each step waits for the other copy's marker message, so the two scripts stay in order.
async function sender() {
  await send('Hello <b>from</b> the sender');
  // A focused receiver reads it at once, so this can go straight to Read.
  await until(`/Delivered|Read/.test(document.getElementById('messages').textContent)`, 'message acknowledged');
  await until(hasText('Got it, thanks'), 'reply received');

  await run(`document.getElementById('seal').click()`);
  await send('The sealed surprise');
  await until(hasText('Opened'), 'sealed message opened by them');

  await run(`document.getElementById('lock').click()`);
  await run(`document.getElementById('password-input').value = 'tiger'; document.getElementById('password-form').requestSubmit();`);
  await sleep(150);
  await send('The locked secret');
  await until(hasText('unlocked it'), 'locked message unlocked by them');

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.SMOKE_FILE] });
  await run(`document.getElementById('attach').click(); document.getElementById('attach-files').click()`);
  await until(`document.querySelectorAll('.transfer .check').length === 1`, 'file sent with no accept step');

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.SMOKE_FOLDER] });
  await run(`document.getElementById('attach').click(); document.getElementById('attach-folder').click()`);
  await until(`document.querySelectorAll('.transfer .check').length === 2`, 'folder sent with no accept step');

  // A real paste event, with an image that has no file path, like a screenshot.
  const png = fs.readFileSync(path.join(__dirname, '..', 'build', 'tray.png')).toString('base64');
  await run(`(() => {
    const bytes = Uint8Array.from(atob(${q(png)}), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.getElementById('text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await until(`document.querySelector('.image-message img')?.naturalWidth === 64`, 'pasted image displays');

  await until(`[...document.querySelectorAll('.person')].some((b) => b.textContent.includes(${q(peerName)}) && b.querySelector('.dot.away'))`, 'away status shown');
  await send('Are you there?');
  await until(hasText('Back after lunch'), 'away reply received');

  await run(`document.getElementById('new-group').click()`);
  await run(`document.getElementById('group-name').value = 'Design team'; document.querySelector('#group-people input').checked = true; document.getElementById('group-form').requestSubmit();`);
  await until(`document.getElementById('chat-title').textContent === 'Design team'`, 'group created');
  await send('Hello group');
  await until(`/Delivered to 1 of 1|Read by 1 of 1/.test(document.getElementById('messages').textContent)`, 'group message delivered');
  await until(hasText('Group reply'), 'group reply received');

  await run(`document.getElementById('search').value = 'sealed surprise'; document.getElementById('search').dispatchEvent(new Event('input'));`);
  await until(`document.querySelector('.result')?.textContent.includes('sealed surprise')`, 'search finds a message');
  await run(`document.querySelector('.result').click()`);
  await until(`document.querySelector('.message.flash') !== null`, 'search opens the message');
  await run(`document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input'));`);
  await clickPerson(peerName);
  await sleep(300);
  await shot('sender.png');
  await until(hasText('finished'), 'partner finished');
}

async function receiver() {
  await until(hasText('Hello <b>from</b> the sender'), 'message received');
  if (await run(`document.querySelectorAll('#messages .bubble b').length`)) throw new Error('message text was rendered as HTML');
  log('ok: message shown as plain text');
  // Quote the sender's message.
  await run(`[...document.querySelectorAll('.message-actions button')].find((b) => b.textContent === 'Reply').click()`);
  await until(`!document.getElementById('reply-bar').hidden`, 'reply bar shown');
  await send('Got it, thanks');
  await until(`document.querySelector('.bubble .quote')?.textContent.includes('from')`, 'quote shown in reply');

  await until(hasButton('Open'), 'sealed message arrives closed');
  if (await run(hasText('sealed surprise'))) throw new Error('sealed text was visible before opening');
  await shot('receiver-sealed.png');
  await clickButton('Open');
  await until(hasText('The sealed surprise'), 'sealed message opens');

  await until(hasButton('Unlock'), 'locked message arrives locked');
  await clickButton('Unlock');
  await run(`document.getElementById('password-input').value = 'wrong'; document.getElementById('password-form').requestSubmit();`);
  await until(`document.getElementById('password-error').textContent === 'Wrong password'`, 'wrong password refused');
  await run(`document.getElementById('password-input').value = 'tiger'; document.getElementById('password-form').requestSubmit();`);
  await until(hasText('The locked secret'), 'locked message unlocks');
  await send('I unlocked it');

  await until(`document.querySelectorAll('.transfer .check').length === 1`, 'file saved with no accept step');
  if (await run(hasButton('Accept'))) throw new Error('an Accept button appeared');
  await until(`document.querySelectorAll('.transfer .check').length === 2`, 'folder saved with no accept step');
  await until(`document.querySelector('.image-message img')?.naturalWidth === 64`, 'pasted image displays');

  await run(`document.getElementById('open-settings').click(); document.getElementById('set-away').checked = true; document.getElementById('set-away-text').value = 'Back after lunch'; document.getElementById('settings-form').requestSubmit();`);
  await until(hasText('Are you there?'), 'message arrived while away');
  await until(`[...document.querySelectorAll('.person')].some((b) => b.textContent.includes('Design team'))`, 'group appears');
  await clickPerson('Design team');
  await until(hasText('Hello group'), 'group message received');
  await send('Group reply');
  await sleep(500);
  await shot('receiver-group.png');
  await clickPerson(peerName);
  await sleep(400);
  await shot('receiver.png');
  await send('finished');
  await run(`document.getElementById('open-settings').click()`);
  await shot('receiver-settings.png');
}

app.whenReady().then(async () => {
  try {
    await sleep(500);
    [win] = BrowserWindow.getAllWindows();
    win.focus();
    await until(hasPerson(peerName), 'peer found by broadcast');
    await clickPerson(peerName);
    await sleep(300);
    await (role === 'sender' ? sender() : receiver());
    log('PASS');
    await sleep(2000);
    app.quit();
  } catch (err) {
    log(`FAIL ${err.message}`);
    try { await shot(`${role}-failure.png`); } catch {}
    app.exit(1);
  }
});
