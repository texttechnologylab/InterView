# Setup Guide

End-to-end deployment of InterView from nothing to a verified interview.


---

## 1. Prerequisites

### Host

- Linux host with a **public or NAT-mapped static IP**
- `docker` + `docker compose`, **or** rootless `podman` + `podman-compose`
- Ability to open UDP port ranges in the firewall

### External services you must already have

| Requirement | Why | If missing |
|---|---|---|
| **MongoDB** instance, reachable from the host | All logged data is written to it | Stand one up first; this stack does not include one |
| **Reverse proxy** with valid TLS certificates | Browsers refuse `getUserMedia` on insecure origins, and the clients are configured for `wss://` | Nothing will connect. Not optional. |
| **DNS records** for your hostnames | Clients address services by name | - |

### Reverse proxy mapping

Your proxy must terminate TLS and route these hostnames to the host. Adapt the
names to your deployment:

| Public hostname | → Host port | Must support |
|---|---|---|
| `interview.example.org` | `18800` | HTTP |
| `janus.example.org` | `8188` | **WebSocket upgrade** |
| `api.example.org` | `16481` | HTTP |

!!! danger "WebSocket upgrade is the single most common setup failure"
    The Janus vhost must forward `Upgrade` and `Connection` headers, and needs a
    generous read timeout - an idle interview connection must not be culled. A
    proxy that serves the page fine but drops the socket produces a client that
    connects, then dies seconds later with no useful error.

    === "nginx"

        ```nginx
        location / {
            proxy_pass http://127.0.0.1:8188;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 3600s;
        }
        ```

    === "Apache"

        ```apache
        # a2enmod proxy proxy_http proxy_wstunnel
        ProxyPass        / ws://127.0.0.1:8188/
        ProxyPassReverse / ws://127.0.0.1:8188/
        ProxyTimeout     3600
        ```

### Firewall

```bash
# Janus RTP - must match rtp_port_range in janus/conf.d/janus.jcfg
sudo ufw allow 20000:20100/udp
# coturn, only if you self-host TURN (step 6)
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 50000:51000/udp
```

!!! warning "UDP is not optional"
    If UDP is blocked outright, media falls back to TURN-over-TCP where quality
    degrades badly, and without TURN it fails entirely.

---

## 2. Get the repository

```bash
git clone https://github.com/texttechnologylab/InterView.git
cd InterView
```

---

## 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DB_SERVER=mongo.example.org      # your MongoDB host
DB_PORT=27017
DB_NAME=Lab2
DB_USERNAME=<mongo user>
DB_PASSWORD=<mongo password>

X_API_KEY=<generate one>         # shared secret for the logging API
RECORDINGS_DIR=/srv/interview/recordings
```

Generate the API key with `openssl rand -hex 32`. The **same value** must be set in
the VR client (step 9).

```bash
mkdir -p "$(grep RECORDINGS_DIR .env | cut -d= -f2)"
```

### Placeholders in the shipped configs

The config files under `janus/conf.d/` and `coturn/` ship with `CHANGEME_`
placeholders wherever a value is deployment-specific. List everything still
outstanding at any point with:

```bash
grep -rn "CHANGEME_" janus/conf.d coturn
```

Steps 6 and 7 walk through what each one should become. **The stack will start
with placeholders still in place and simply fail to connect**, so re-run this
before your first test.

!!! danger "Never commit `.env`"
    It is gitignored. Anything that ends up in the repository - or in a Unity
    scene, or in the web client's `settings.js` - must be treated as public and
    rotated on a schedule. That applies to the TURN credentials in particular:
    they are necessarily shipped to every browser.

---

## 4. Ubiq server

Keeps VR room state in sync. No configuration needed for a standard deployment.

```bash
docker compose up -d ubiq
docker compose logs ubiq
```

Verify:

```bash
curl -sf http://localhost:16486/ >/dev/null && echo "ubiq status endpoint up"
```

The Unity client will connect to TCP port **16485**.

??? note "Building Ubiq from source instead of using the published image"
    The server lives in the
    [Va.Si.Li-Lab-backend](https://github.com/texttechnologylab/Va.Si.Li-Lab-backend)
    monorepo under `ubiq-server/`. Configuration is layered by `nconf`:
    `config/default.json` holds the committed defaults, `config/local.json`
    overrides them and stays out of source control. To pin ICE servers for the VR
    side, add an `iceservers` array there. See [Ubiq Server](services/ubiq.md).

---

## 5. Logging API

Writes tracking data and events to MongoDB.

```bash
docker compose up -d database-api
docker compose logs database-api
```

Verify - the first call must fail and the second must succeed:

```bash
curl -s -o /dev/null -w "no key  -> %{http_code}\n" http://localhost:16481/logging/status
curl -s -o /dev/null -w "with key-> %{http_code}\n" \
     -H "X-API-KEY: $(grep X_API_KEY .env | cut -d= -f2)" \
     http://localhost:16481/logging/status
```

If the second call does not succeed, the API cannot reach MongoDB - check
`docker compose logs database-api` for a connection error before continuing.

---

## 6. coturn *(optional)*

Skip this if you already have a TURN server, or if every client will sit on a
network where STUN alone suffices. **In practice, headsets on university or
conference wifi need it.**

Edit `coturn/turnserver.conf` - at minimum:

```ini
listening-ip=<host private IP>
relay-ip=<host private IP>
external-ip=<public IP>/<private IP>    # omit the pair if not behind NAT
realm=turn.example.org
user=<username>:<password>
cli-password=<admin password>
```

```bash
docker compose up -d coturn
```

Verify from **another machine** - testing from the host itself proves nothing:

```bash
turnutils_uclient -T -u <username> -w <password> <public IP> -p 3478
```

Or paste the credentials into the
[Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
and confirm at least one candidate of type **`relay`** appears.

!!! warning "Review the peer policy before exposing this"
    The shipped config permits relaying to any address including loopback and the
    local network. Combined with static credentials that ship to every browser,
    that is an open relay into your network. See [coturn](services/coturn.md#security).

---

## 7. Janus

The media server. InterView consumes a prebuilt, pinned image from
[Janus-Gateway](https://github.com/texttechnologylab/Janus-Gateway) - **nothing is
compiled here**. The image ships Janus's stock configuration; you supply only the
files you change.

### Edit `janus/conf.d/janus.jcfg`

| Setting | Change to | Why |
|---|---|---|
| `interface` | your network interface (`ip -br addr`) | ICE binds to it |
| `ice_enforce_list` | the same interface | Stops candidates being gathered on irrelevant interfaces |
| `nat_1_1_mapping` | your **public** IP | Without it Janus advertises a private address and nothing connects |
| `turn_server` / `turn_port` | your TURN host and port | Omit if not self-hosting |
| `turn_user` / `turn_pwd` | your TURN credentials | Replace the `CHANGEME_` placeholders |

Also replace `CHANGEME_ROOM_SECRET` in `janus/conf.d/janus.plugin.videoroom.jcfg`.

!!! note "Only two files live here, and each is a complete config"
    Everything else is byte-identical to stock Janus and comes from the image.
    Janus config files do not merge - an override replaces a whole file - so
    these are full copies of the defaults with a handful of lines changed. See
    [Janus](services/janus.md#how-configuration-works-here).

### Start

```bash
docker compose up -d janus
docker compose logs -f janus
```

Confirm your overrides were applied, and that the two plugins InterView needs
loaded:

```bash
docker compose logs janus | grep "applied override"
docker compose logs janus | grep -E "videoroom|textroom|WebSockets"
```

Verify the API answers:

```bash
curl -s http://localhost:8088/janus/info | head -c 300
```

Then confirm it is reachable **through the proxy as TLS** - this is what clients
actually use:

```bash
curl -sfI https://janus.example.org | head -3
```

!!! tip "Pinning and upgrades"
    The version comes from `JANUS_TAG` in `.env`. Changing it changes the
    gateway - never do so during a data collection period. See
    [Building](https://texttechnologylab.github.io/Janus-Gateway/building/).

---

## 8. Web client

Source lives in this repository under `website/`. Point it at your Janus and TURN
servers by editing `website/janus-html/settings.js`:

```javascript
server = [ "wss://janus.example.org", "/janus" ];

iceServers = [
    { urls: "turn:turn.example.org:3478",                username: "<user>", credential: "<password>" },
    { urls: "turn:turn.example.org:3478?transport=tcp",  username: "<user>", credential: "<password>" },
    { urls: "stun:stun1.l.google.com:3478" }
];
```

It is a static file - `docker compose` bakes it into the image, so build after
editing:

```bash
docker compose build website
docker compose up -d website
curl -sf http://localhost:18800/ >/dev/null && echo "website up"
```

See [Web Client](services/web_client.md).

Open `https://interview.example.org/` - you should get the token entry page with
separate participant and interviewer forms.

---

## 9. VR client

Built from [Va.Si.Li-Lab](https://github.com/texttechnologylab/Va.Si.Li-Lab).

Unity project setup, building for Quest and the full component configuration are
documented in the Va.Si.Li-Lab docs:
**[InterView VR Client](https://texttechnologylab.github.io/Va.Si.Li-Lab/getting_started/interview_client/)**.

Point the client at the services you just deployed:

| Component | Setting | Value |
|---|---|---|
| `WebCamClient` | `ServerUrl` | `wss://janus.example.org` |
| `WebCamClient` | `IceServers` | Your TURN credentials (step 6) |
| `RoomClient` | connection definition | Your host, port **16485** (step 4) |
| Va.Si.Li API asset | `host`, API key | Your API URL and the `X_API_KEY` from `.env` (step 5) |
| `InterviewTokenManager` | `BrowserBaseUrl` | Your questionnaire URL |

!!! danger "Two settings fail silently if they are wrong"
    A mismatched **API key** produces a session that runs perfectly and records
    nothing. A divergent **token derivation** puts interviewer and participant in
    different rooms with no error. Both are covered in
    [VR Client](services/vr_client.md#cross-repository-contracts).

---

## 10. Verify end to end

Start everything and confirm it stays up:

```bash
docker compose up -d
docker compose ps
```

All five services should read `running`. Then run a real two-party test - no
single-endpoint check substitutes for it:

1. Open `https://interview.example.org/interviewer?ID=testrun001` in a browser.
   Grant camera and microphone access.
2. Open `https://interview.example.org/interview?ID=testrun001` in a **second
   browser or private window**, acting as the participant.
3. Confirm, in order:

    - [ ] Both sides see and hear each other
    - [ ] Chat messages arrive *(proves the data channel works)*
    - [ ] The interviewer can push answer options and they appear for the participant
    - [ ] Recording toggles on, and `.mjr` files appear in `RECORDINGS_DIR`
    - [ ] Data arrives in MongoDB for the session

4. Repeat with the VR client in place of the participant browser, using a token
   entered in the headset.

!!! success "If all five pass, the deployment is complete."
    If any fail, [Operations](operations.md#troubleshooting) maps each symptom to
    its usual cause.
