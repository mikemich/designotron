# Online multiplayer: the Designotron relay

**Share → Online** puts your file in a room on a *relay*: a small open-source server
(`crates/relay`) that merges everyone's edits and passes cursors around. Anyone with the
link can join from anywhere. The relay also serves the editor, so one deployment gives you
the link people open and the rooms behind it.

The relay never runs Claude, MCP or any tools. It only stores and relays shared files.

## Deploy one

### Free: Render (about 3 minutes, no server to manage)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mikemich/designotron)

1. Click the button, sign in to Render with GitHub, and click **Deploy Blueprint**.
   `render.yaml` runs the public relay image on the free plan.
2. Copy the service URL (like `https://designotron-relay-xxxx.onrender.com`).
3. In this repository, add it as the variable `DT_RELAY_URL` (Settings → Secrets and
   variables → Actions → Variables), then re-run Actions → **Hosted editor**. Share →
   Online now works with no setup for anyone.
4. Optional: copy the service's Settings → **Deploy Hook** URL into a repository secret
   `RENDER_DEPLOY_HOOK`, so every push to `main` redeploys it.

Free services sleep after about 15 idle minutes. The first person to share or join wakes
the relay (up to a minute); rooms held in memory are lost when it sleeps, and editors that
reconnect put the file back. Everyone keeps their own copy of the file either way.

Any host that runs a Docker image and supports WebSockets over HTTPS works. The image is
published to `ghcr.io/mikemich/designotron-relay` on every push to `main`, or build it from
this repo's `Dockerfile`.

### Fly.io from GitHub (automatic)

Add a repository secret `FLY_API_TOKEN` (fly.io → Tokens) and a variable `FLY_APP` (a
unique name) in Settings → Secrets and variables → Actions, then run Actions → **Deploy
relay**. It creates the app and its volume, deploys, checks `/health`, and rebuilds the
hosted editor with `https://<FLY_APP>.fly.dev` as its default relay. After that every push
to `main` redeploys it. Fly bills a small always-on machine (a few dollars a month).

### Fly.io by hand

```bash
fly launch --copy-config --no-deploy      # choose a unique app name
fly volumes create designotron_rooms --size 1
fly deploy
```

Your relay is `https://<app-name>.fly.dev`.

### Any server with Docker

```bash
docker run -d --restart unless-stopped -p 8080:8080 -v designotron-rooms:/data \
  ghcr.io/mikemich/designotron-relay
```

Put it behind HTTPS (Caddy, nginx, a Cloudflare tunnel); browsers on the hosted editor
can only reach `https`/`wss` relays.

### Without Docker

```bash
cd web && npm ci && npm run build && cd ..
cargo run --release -p designotron-relay -- --port 8080 --static web/dist --data ./rooms
```

## Use it

1. Open the editor (the relay's own URL, the hosted editor, or your local one).
2. **Share** (toolbar) → **Online** → paste the relay address → **Share online**.
3. Send the link. Everyone who opens it edits the same file, with live cursors and
   selections; each person's undo only reverts their own changes.

When you open the editor from the relay's own URL, the address is filled in for you.

To make a relay the default for the hosted editor (GitHub Pages), add a repository
variable `DT_RELAY_URL` (Settings → Secrets and variables → Actions → Variables) and
re-run the "Hosted editor" workflow. Without it, the hosted editor uses
`https://<FLY_APP>.fly.dev` when `FLY_APP` is set. Local builds read `VITE_DT_RELAY`.

## Configuration

| Setting                              | Default               | Meaning                                                              |
|--------------------------------------|-----------------------|----------------------------------------------------------------------|
| `PORT` / `--port`                    | 8787                  | Listen port (the Docker image uses 8080)                             |
| `DESIGNOTRON_STATIC` / `--static`    | `web/dist` if present | Editor build to serve; omit to serve rooms only                      |
| `DESIGNOTRON_DATA` / `--data`        | none                  | Directory where rooms are saved; without it rooms live in memory     |
| `DESIGNOTRON_MAX_ROOMS`              | 1000                  | Rooms held in memory at once                                         |
| `DESIGNOTRON_MAX_ROOM_BYTES`         | 50MB                  | Largest shared file (document + images, as JSON)                     |
| `DESIGNOTRON_MAX_TOTAL_BYTES`        | 192MB                 | Memory budget for all rooms and connections (see below)              |
| `DESIGNOTRON_MAX_CONNECTIONS_PER_IP` | 20                    | WebSocket connections open at once from one address                  |
| `DESIGNOTRON_MAX_NEW_ROOMS_PER_HOUR` | 30                    | Rooms one address may create an hour (joining one doesn't count)     |
| `DESIGNOTRON_TRUST_PROXY`            | 0                     | `1` behind one proxy that appends to `X-Forwarded-For` (Render, Fly) |

Byte sizes take `k`, `MB` or `G` suffixes or a plain number of bytes. Behind a proxy without
`DESIGNOTRON_TRUST_PROXY`, every client shares the proxy's address and limits; with it
set but no proxy in front, clients can pick their own address. With `1` the right-most
`X-Forwarded-For` entry is used (the one the host's proxy added; entries to its left come
from the client); use `2` if there are two proxies in front. IPv6 addresses are grouped
by /64.

### Limits

- **Files and people**: 50 people per room, 50 MB per shared file (images included).
  WebSocket messages are capped at that size plus 1 MB. Images that would push a file past
  the limit are not shared, and other changes that would are refused (the editor says
  so either way). Rooms untouched for 7 days are deleted.
- **Memory budget**: the relay counts approximate bytes held by rooms (each document and
  its images, as JSON) and by connections (WebSocket buffers keep the capacity of the
  largest message they carried, so every editor that received a 20 MB file holds about
  20 MB; plus messages queued for it). Over the budget it first unloads rooms nobody is
  connected to, least recently active first (with a data dir they are saved first and
  reload on the next join; without one they are dropped, and an editor that reconnects
  puts the file back). If that isn't enough, new rooms and joins that need memory get
  "This relay is busy right now; try again in a minute." Rooms with people in them are
  never dropped, and their edits keep working past the budget. The default leaves half of
  a 512 MB host (Render free, the Fly config) for what the count doesn't see: parsed
  documents and copies made while a file is sent.
- **Slow connections**: an editor that stops reading (16 MB queued for it) is disconnected
  and reconnects to the current file instead of the relay buffering without bound;
  cursors are skipped for editors a little behind.
- **Message rate**: each connection may send 100 messages a second sustained, in bursts
  of up to 300 (an editor sends a change per animation frame while dragging, 60–120 a
  second, plus cursor updates at up to 25 a second). Over the rate, cursor updates are
  dropped and changes are slowed down, never lost; a connection that stays over it for
  30 seconds without a pause is disconnected with an error.
- **Per address**: 20 open connections and 30 new rooms an hour. Over either, the
  WebSocket upgrade gets HTTP 429 and the editor retries with growing pauses (up to a
  minute).

`GET /health` reports `rooms`, `people` and `memory` (`bytes` in use, `budget`, and the
split into `roomBytes` and `connectionBytes`), plus `relay`, `version` and `editor`.

## Security model

- The room id in the link (128 random bits) is the only key: anyone with the link can view
  and edit, and nobody can guess one. Share links like you would a Google Doc link.
- There are no accounts. Shared files are stored on the relay's disk in plain JSON; run
  your own relay for anything sensitive.
- A relay cannot reach anything on the computers that join; the editor only exchanges
  document data with it.
- Abuse limits: per-address connection and room-creation limits, a per-connection message
  rate, size caps on messages and files, and the memory budget keep one client from taking
  the relay down. They are not a defence against a distributed attack: many addresses
  can still fill the budget (the relay then turns new work away rather than run out of
  memory) or tie up bandwidth, and messages still arriving are not counted until they
  are complete (one address could have 20 large uploads in flight). Put a CDN or a
  firewall in front of a relay that needs more than that.
