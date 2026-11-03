# Beacon

Serverless encrypted chat and file transfer for the office network.

## Commands

    npm install
    npm start          # run from source
    npm test           # core networking and security tests
    npm run dist:mac   # dist/*.dmg (arm64 and x64)
    npm run dist:win   # dist/*.exe
    npm run site       # site-dist, using the built installers

Set `DOWNLOAD_BASE` when building the site if the installers are hosted elsewhere,
for example `DOWNLOAD_BASE=https://example.com/releases npm run site`.

## Tests

    npm test
    BEACON_UDP_PORT=34250 SMOKE_ROLE=receiver ... electron test/smoke.js

Always set `BEACON_UDP_PORT` when running the interface test. Without it, its fake users
broadcast on the real discovery port and appear on colleagues' computers.

## Releasing an update

Installed copies check the latest GitHub release for a signed `update.json`.

    npm run dist:mac && npm run dist:win
    npm run sign-update

Upload `dist/update.json`, the two `*-mac.zip` files, the `.dmg` files and the `.exe` to a new
GitHub release. The signing key is at `~/.beacon/update-signing-key.pem`. Keep a safe backup and
never commit it: without it, installed copies can't be updated, and anyone who has it can
update every installed copy.

## Network requirements

- UDP 24250 for finding colleagues (broadcast on the local subnet)
- TCP 24251 for messages and files, inbound and outbound
- Other subnets: add their broadcast address or a computer's IP in Settings
- Guest Wi-Fi and networks with client isolation will block it

## Known limits

- Installers are not signed, so macOS and Windows show security warnings.
- Versions before 0.3.0 can't update themselves and need one manual install.
- Anyone on the network who runs the app can appear and send messages. Display
  names are self-declared, so use the device ID to confirm identity.
- Files and folders download automatically by default, from anyone on the network.
  They are never opened automatically. Turn this off in Settings to accept each one.
- Traffic is encrypted, but chat history is stored unencrypted in the app's data
  folder, except password-locked messages.
- A queued message is delivered only while both people have the app running.
- Everyone messages go only to people online when they are sent.
- Files and folders go to one person at a time, not to groups or Everyone.
- Interrupted transfers restart from the beginning.

## Website

`site-dist` is the built download site, committed so Vercel can serve it without the
installers. Vercel reads `vercel.json` and needs no other settings.

After a new version, upload the installers to a GitHub release, then rebuild the site and commit it:

    DOWNLOAD_BASE=https://github.com/HARIHARANMURALIREC/Beacon-/releases/download/v0.2.0 npm run site
