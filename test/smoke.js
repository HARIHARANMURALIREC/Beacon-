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

async function until(win, expression, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return log(`ok: ${label}`);
    await sleep(150);
  }
  throw new Error(`timed out: ${label}`);
}

const clickPerson = (name) => `[...document.querySelectorAll('.person')].find((b) => b.textContent.includes(${JSON.stringify(name)})).click()`;
const hasPerson = (name) => `[...document.querySelectorAll('.person')].some((b) => b.textContent.includes(${JSON.stringify(name)}) && b.querySelector('.dot.online'))`;
const hasText = (text) => `document.getElementById('messages').textContent.includes(${JSON.stringify(text)})`;

async function shot(win, name) {
  win.show();
  await sleep(300);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
}

app.whenReady().then(async () => {
  try {
    await sleep(500);
    const [win] = BrowserWindow.getAllWindows();
    await until(win, hasPerson(peerName), 'peer found by broadcast');
    await win.webContents.executeJavaScript(clickPerson(peerName));
    if (role === 'sender') {
      await sleep(300);
      await win.webContents.executeJavaScript(`
        document.getElementById('text').value = 'Hello <b>from</b> the sender';
        document.getElementById('composer').requestSubmit();
      `);
      await until(win, hasText('Delivered'), 'message acknowledged');
      await until(win, hasText('Got it, thanks'), 'reply received');
      // The native picker can't be driven from here, so only the chosen path is stubbed.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.SMOKE_FILE] });
      await win.webContents.executeJavaScript(`document.getElementById('attach').click()`);
      await until(win, hasText('Waiting for them to accept'), 'file offered');
      await until(win, hasText('Sent'), 'file sent');
    } else {
      await until(win, hasText('Hello <b>from</b> the sender'), 'message received');
      const unsafe = await win.webContents.executeJavaScript(`document.querySelectorAll('#messages b').length`);
      if (unsafe) throw new Error('message text was rendered as HTML');
      log('ok: message shown as plain text');
      await win.webContents.executeJavaScript(`
        document.getElementById('text').value = 'Got it, thanks';
        document.getElementById('composer').requestSubmit();
      `);
      await until(win, hasText('Got it, thanks'), 'reply sent');
      await until(win, `[...document.querySelectorAll('.file-actions .primary')].some((b) => b.textContent === 'Accept')`, 'file offer shown');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.file-actions .primary')].find((b) => b.textContent === 'Accept').click()`);
      await sleep(450);
      await shot(win, 'receiver-transfer.png');
      await until(win, `document.querySelector('.track') !== null || document.querySelector('.check') !== null`, 'transfer animation shown');
      await until(win, hasText('Show in folder'), 'file saved');
      await until(win, `document.querySelector('.transfer .check') !== null`, 'completion animation shown');
    }
    await shot(win, `${role}.png`);
    await win.webContents.executeJavaScript(`document.getElementById('open-settings').click()`);
    await shot(win, `${role}-settings.png`);
    log('PASS');
    await sleep(3000);
    app.quit();
  } catch (err) {
    log(`FAIL ${err.message}`);
    app.exit(1);
  }
});
