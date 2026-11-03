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

## Network requirements

- UDP 24250 for finding colleagues (broadcast on the local subnet)
- TCP 24251 for messages and files, inbound and outbound
- Other subnets: add their broadcast address or a computer's IP in Settings
- Guest Wi-Fi and networks with client isolation will block it

## Known limits

- Installers are not signed, so macOS and Windows show security warnings.
- No automatic updates. Each new version must be installed manually.
- Anyone on the network who runs the app can appear and send messages. Display
  names are self-declared, so use the device ID to confirm identity.
- Traffic is encrypted, but chat history is stored unencrypted in the app's data folder.
- A queued message is delivered only while both people have the app running.
- Everyone messages go only to people online when they are sent.
- Single files only: no folders, and interrupted transfers restart from the beginning.

## Website

`site-dist` is the built download site, committed so Vercel can serve it without the
installers. Vercel reads `vercel.json` and needs no other settings.

After a new version, upload the installers to a GitHub release, then rebuild the site and commit it:

    DOWNLOAD_BASE=https://github.com/HARIHARANMURALIREC/Beacon-/releases/download/v0.1.0 npm run site
