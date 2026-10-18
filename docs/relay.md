# Online multiplayer: the Designotron relay

**Share → Online** puts your file in a room on a *relay*: a small open-source server
(`crates/relay`) that merges everyone's edits and passes cursors around. Anyone with the
link can join from anywhere. The relay also serves the editor, so one deployment gives you
the link people open and the rooms behind it.

The relay never runs Claude, MCP or any tools. It only stores and relays shared files.

## Deploy one

Any host that runs a Docker image and supports WebSockets over HTTPS works. The image is
published to `ghcr.io/mikemich/designotron-relay` on every push to `main`, or build it from
this repo's `Dockerfile`.

### Fly.io (about 5 minutes)

```bash
fly launch --copy-config --no-deploy      # choose a unique app name
fly volumes create designotron_rooms --size 1
fly deploy
```

Your relay is `https://<app-name>.fly.dev`.

### Render

Dashboard → **New → Blueprint** → choose this repository. `render.yaml` sets up the
service and a 1 GB disk. The URL looks like `https://designotron-relay.onrender.com`.

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
re-run the "Hosted editor" workflow. Local builds read `VITE_DT_RELAY`.

## Configuration

| Setting                         | Default    | Meaning                                                  |
|---------------------------------|------------|----------------------------------------------------------|
| `PORT` / `--port`               | 8787       | Listen port (the Docker image uses 8080)                 |
| `DESIGNOTRON_STATIC` / `--static` | `web/dist` if present | Editor build to serve; omit to serve rooms only |
| `DESIGNOTRON_DATA` / `--data`   | none       | Directory where rooms are saved; without it rooms live in memory |
| `DESIGNOTRON_MAX_ROOMS`         | 1000       | Rooms held at once                                       |

Limits: 50 people per room, 50 MB per shared file (images included), rooms untouched for
7 days are deleted. `GET /health` reports rooms and people.

## Security model

- The room id in the link (128 random bits) is the only key: anyone with the link can view
  and edit, and nobody can guess one. Share links like you would a Google Doc link.
- There are no accounts. Shared files are stored on the relay's disk in plain JSON; run
  your own relay for anything sensitive.
- A relay cannot reach anything on the computers that join; the editor only exchanges
  document data with it.
