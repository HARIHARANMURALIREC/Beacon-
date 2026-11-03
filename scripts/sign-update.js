'use strict';
// Writes dist/update.json: the signed list of installers that every copy of Beacon checks.
// The private key stays outside the repo. Whoever holds it can update every installed copy.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyDir = path.join(os.homedir(), '.beacon');
const keyFile = path.join(keyDir, 'update-signing-key.pem');
const publicFile = path.join(__dirname, '..', 'src', 'core', 'update-key.js');

function loadKey() {
  if (fs.existsSync(keyFile)) return crypto.createPrivateKey(fs.readFileSync(keyFile));
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Created a signing key at ${keyFile}. Back it up somewhere safe.`);
  return privateKey;
}

function writePublicKey(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  fs.writeFileSync(publicFile, `'use strict';\n// Only updates signed by the matching private key are installed.\nmodule.exports = '${der}';\n`);
}

const privateKey = loadKey();
writePublicKey(privateKey);
if (process.argv.includes('--key-only')) process.exit(0);

const dist = path.join(__dirname, '..', 'dist');
const version = process.env.UPDATE_VERSION || require('../package.json').version;
const artifacts = {
  win32: `Beacon-Setup-${version}.exe`,
  'darwin-arm64': `Beacon-${version}-arm64-mac.zip`,
  'darwin-x64': `Beacon-${version}-x64-mac.zip`,
};
const files = {};
for (const [platform, name] of Object.entries(artifacts)) {
  const full = path.join(dist, name);
  if (!fs.existsSync(full)) {
    if (process.env.UPDATE_ALLOW_MISSING) continue;
    throw new Error(`Missing ${name}`);
  }
  const data = fs.readFileSync(full);
  files[platform] = { name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
const payload = Buffer.from(JSON.stringify({ version, files })).toString('base64');
const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
fs.writeFileSync(path.join(dist, 'update.json'), JSON.stringify({ payload, signature }, null, 2));
console.log(`Signed update.json for ${version}: ${Object.keys(files).join(', ')}`);
