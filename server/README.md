# Authoritative race server

A small Node/`ws` service for two-player races. It owns the seed, countdown,
60 Hz physics, collisions, finish order, and rematch. Browsers send only four
control bits and receive 20 Hz snapshots.

## Local

```bash
cd server
npm install
npm start
# health: http://127.0.0.1:8788/health
```

The service binds `127.0.0.1:8788` by default. Set `HOST`/`PORT` only when
placing it behind a trusted proxy. `RACE_SECONDS` is a test-only shortening of
the default 60 second race.

## Client

The frontend enters a room when loaded as:

```text
https://driftrace.tech/?room=ABCD
```

It uses same-origin `wss://<page-host>/ws` when this service serves the page
(`race.driftrace.tech`), falls back to `wss://race.driftrace.tech/ws` when the
page is hosted elsewhere, and uses `ws://127.0.0.1:8788/ws` locally.
`?ws=wss://host/ws` overrides the endpoint for testing. Without `?room=`, the
original local single-player mode is used.

## VPS service

The unit in `driftrace-race.service` runs as a loopback-only systemd service.
On this VPS it is installed at `/etc/systemd/system/driftrace-race.service`.

```bash
systemctl status driftrace-race
journalctl -u driftrace-race -f
curl http://127.0.0.1:8788/health
```

## Public access

The public route is a named Cloudflare Tunnel, so no inbound port is opened and
the hostname is stable across restarts:

```text
https://race.driftrace.tech/          page served by this service
wss://race.driftrace.tech/ws          multiplayer endpoint
```

The zone `driftrace.tech` is delegated to Cloudflare
(`sue.ns.cloudflare.com`, `dion.ns.cloudflare.com`). The tunnel `driftrace-race`
(`fe0323cd-dd71-4dad-93d5-13b1f3f86b21`) is proxied behind `race`, and its ingress
maps `race.driftrace.tech` to `http://127.0.0.1:8788`:

```bash
cloudflared tunnel list
cloudflared tunnel info driftrace-race
systemctl status cloudflared
journalctl -u cloudflared -f
```

Tunnel configuration lives in `/etc/cloudflared/config.yml`; credentials are in
`/root/.cloudflared/` and are not committed. Recreating the route:

```bash
cloudflared tunnel route dns --overwrite-dns driftrace-race race.driftrace.tech
```

`Caddyfile` remains as an alternative reverse proxy for
`8-221-120-192.sslip.io`. The `caddy.service` unit and `/etc/caddy/Caddyfile` are
installed on this VPS but intentionally stopped: the Aliyun security group drops
inbound 80/443, so Let's Encrypt validation would only exhaust retries. It is
not needed while the tunnel is in place.

## Two-browser test

Install test dependencies once:

```bash
cd tests
npm install
npx playwright install chromium
```

Then run the server plus a static server, and point the test at them:

```bash
cd server && npm start
python3 -m http.server 8789 --bind 127.0.0.1
# in another shell:
cd tests
MP_BASE=http://127.0.0.1:8789/index.html \
MP_WS=ws://127.0.0.1:8788/ws \
npm test
```

The test opens two isolated browser contexts, verifies distinct `p1`/`p2`
slots, waits for the server countdown, sends throttle input, checks that both
snapshots contain two moving cars, and verifies the authoritative result and
automatic rematch. `MP_SKIP_FINISH=1` skips the finish/rematch half.
