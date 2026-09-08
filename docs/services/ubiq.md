# Ubiq Server

The room and session server for the VR side. It keeps shared VR state - avatars,
transforms, object ownership - synchronised between connected headsets.

Built on [Ubiq](https://ubiq.online/) (UCL), extended in the
[Va.Si.Li-Lab-backend](https://github.com/texttechnologylab/Va.Si.Li-Lab-backend)
monorepo under `ubiq-server/`.

!!! info "Not part of the call"
    Ubiq carries **no audio or video**. Those go through
    [Janus](janus.md). Ubiq only moves state. The two are independent: a session
    can have working voice and broken avatars, or the reverse.

## Ports

| Port | Container | Host | Purpose |
|---|---|---|---|
| TCP room server | 8009 | 16485 | What the Unity client connects to |
| Status | 8011 | 16486 | Health and metrics |
| Secure WebSocket | 8010 | - | Not exposed; VR clients use TCP |

## Configuration

Configuration is layered by [`nconf`](https://github.com/indexzero/nconf), loaded
**first-wins**:

1. Files passed as command-line arguments
2. `config/local.json` - deployment overrides, **not** in source control
3. `config/default.json` - committed defaults

So to change a setting, add it to `config/local.json` rather than editing the
committed defaults.

```json
{
    "roomserver": {
        "tcp": { "port": 8009 },
        "wss": { "port": 8010, "cert": "./cert.pem", "key": "./key.pem" }
    },
    "status": { "port": 8011, "cert": "./cert.pem", "key": "./key.pem", "apikeys": [] },
    "iceservers": [
        { "uri": "turn:turn.example.org:3478", "username": "<user>", "password": "<password>" }
    ]
}
```

The `iceservers` block is handed to VR clients on connect. It is **separate** from
the ICE configuration in the Unity `WebCamClient` component and from Janus's own
`turn_server`; see [coturn](coturn.md).

## Room naming

InterView derives the Ubiq room name from the participant token:

```
ubiq room name = "interview-{token}"
```

Implemented in `InterviewTokenManager.UbiqRoomName`. See
[Token and room derivation](../architecture.md#token-and-room-derivation).

## Building from source

```bash
cd ubiq-server
npm install
node --loader ts-node/esm app.ts
```

The published image is `docker.texttechnologylab.org/vasili/ubiq-server:latest`.

## Operations

```bash
docker compose logs -f ubiq
curl -sf http://localhost:16486/ && echo " ubiq up"
```
