# Web Client

A static site served by nginx. It provides the interviewer's console and a
browser-based participant view that doubles as a non-VR fallback and as the
easiest way to test a deployment.

Source lives in this repository, under `website/`.

There is **no server-side logic** - nginx serves files, and everything happens in
the browser against Janus.

## Routes

| Route | Serves | Role |
|---|---|---|
| `/` | Token entry page | Separate participant and interviewer forms |
| `/interview?ID=<token>` | Participant view | `INTERVIEW_ROLE = 'interviewee'` |
| `/interviewer?ID=<token>` | Interviewer console | `INTERVIEW_ROLE = 'interviewer'` |
| `/chat?ID=<token>` | Standalone chat | |
| `/demos/` | Stock Janus demos | Debugging - `echotest` is useful for isolating a client media problem |

Both interview routes accept `ID` or `room`. Without one, the page redirects to
`/`. The token is converted to a Janus room ID by `roomIdFromString()` in
`js/state.js` - which **must** stay identical to the VR client's version. See
[Token and room derivation](../architecture.md#token-and-room-derivation).

## Features

| Feature | Available to | Notes |
|---|---|---|
| Pre-interview device check | both | Camera/mic preview and device selection before joining |
| Device switching | both | Mid-session, without rejoining |
| Virtual background | both | Interviewer defaults to `office`, participant to `none` |
| Chat | both | Over the textroom data channel |
| Answer options | interviewer → participant | Pushed live; the participant's response is logged |
| Gaze overlay | interviewer | Live view of participant gaze |
| Follow-up prompts | interviewer | |
| Recording control | interviewer | Toggles server-side recording; participant sees an indicator |
| Diagnostics | both | Connection state and statistics |

## Configuration

Everything deployment-specific is in `janus-html/settings.js`. Because it is
static, **changing it means rebuilding the image** - there is no runtime
configuration.

```javascript
server = [ "wss://janus.example.org", "/janus" ];

iceServers = [
    { urls: "turn:turn.example.org:3478",               username: "<user>", credential: "<password>" },
    { urls: "turn:turn.example.org:3478?transport=tcp", username: "<user>", credential: "<password>" },
    { urls: "stun:stun1.l.google.com:3478" }
];
```

!!! warning "These credentials are public by construction"
    `settings.js` is downloaded by every browser that opens the page. TURN
    credentials placed here are readable by anyone. Treat them as published,
    rotate them, and read [coturn security](coturn.md#security).

## Building

`docker compose` builds this image itself from `./website` - there is nothing to
publish or pin. Edit `website/janus-html/settings.js`, then:

```bash
docker compose build website
docker compose up -d website
```

The image is `nginx:alpine` with a custom config (`website/nginx.conf`) providing
the pretty routes and adding `.mjs` and `.wasm` MIME types - the latter is needed
by the virtual background.

## Known issue: answer options occasionally not arriving

Symptom: the interviewer pushes answer options and they never appear for the
participant, **while audio and video continue working normally**.

That selectivity is the diagnostic. Audio, video and the control channel share
the same network path and TURN server, so a fault affecting only one of them is
not a network fault. The textroom needs several extra round trips that media does
not - SCTP association, then `create`, then `join` - and it previously ran under a
hard 12-second deadline that discarded all progress on expiry and restarted ICE
from zero. On a good network that never fires; on a marginal one it is a coin
flip.

Client-side fixes have shipped: the deadline behaviour was reworked, and
recording state is now re-broadcast on a heartbeat instead of sent once.

!!! note "One server-side item remains open"
    Widening Janus's `rtp_port_range` was identified as still needed, so that one
    struggling session cannot degrade others. See
    [Janus configuration](janus.md#what-interview-changes).

Full analysis: [Web Client Reliability](web-client-reliability.md).
