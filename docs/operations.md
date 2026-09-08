# Operations

Running the stack day to day: recordings, common failures, and maintenance.

## Service control

```bash
docker compose up -d           # start everything
docker compose ps              # all five should read "running"
docker compose logs -f janus   # follow one service
docker compose restart janus   # apply a config change
docker compose down            # stop everything
```

!!! warning "Restarts drop live calls"
    Janus does not reload configuration - a change needs a restart, and a restart
    ends every session in progress. Never restart during an interview.

## Recordings

Janus writes `.mjr` files into a per-token directory under `RECORDINGS_DIR`:

```
recordings/
└── <token>/
    ├── videoroom-<room>-user-<id>-<ts>-audio-0.mjr
    ├── videoroom-<room>-user-<id>-<ts>-video-1.mjr
    ├── videoroom-<room>-user-<id2>-<ts>-audio-0.mjr
    └── videoroom-<room>-user-<id2>-<ts>-video-1.mjr
```

Four files per two-party interview: **audio and video are recorded separately for
each participant.** That separation is useful for analysis - each speaker's audio
is already isolated - but it means playback requires post-processing.

!!! info "Capacity"
    Roughly **450 MB per interview**, dominated by video. The FACES corpus is
    about 16 GB across 55 sessions. Recordings are never cleaned up
    automatically; plan storage and archival accordingly.

### Converting to playable media

`.mjr` is a Janus container, not something a player understands. Convert with
`janus-pp-rec`, which is built into the image:

```bash
# audio
docker compose exec janus janus-pp-rec \
    /mnt/recordings/<token>/videoroom-...-audio-0.mjr /mnt/recordings/<token>/audio.opus

# video
docker compose exec janus janus-pp-rec \
    /mnt/recordings/<token>/videoroom-...-video-1.mjr /mnt/recordings/<token>/video.webm
```

Then mux a participant's two tracks:

```bash
ffmpeg -i video.webm -i audio.opus -c copy participant.webm
```

!!! note "Tracks are not aligned by file order"
    Each `.mjr` carries its own timestamps. To align two participants, use those
    rather than assuming the files start together - one side joins before the
    other in essentially every session.

### Verifying a recording immediately after a session

```bash
ls -la "$RECORDINGS_DIR/<token>/"
```

Expect four non-trivial files. A zero-byte or missing file means recording never
started on that track - worth catching while the participant is still available.

## Troubleshooting

### Clients connect, then no audio or video

The most common failure, and almost always NAT.

1. Check `nat_1_1_mapping` in `janus/conf.d/janus.jcfg` holds the **current public
   IP**. A stale value produces exactly this symptom.
2. Confirm the RTP range (`20000-20100/udp`) is open in the firewall.
3. Confirm `interface` and `ice_enforce_list` name a real interface (`ip -br addr`).
4. Check for `relay` candidates with the
   [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).

### Client connects, then disconnects after a few seconds

Usually the reverse proxy, not Janus. The vhost must forward `Upgrade` and
`Connection` headers and allow a long read timeout - see
[Setup step 1](setup.md#reverse-proxy-mapping). A proxy that serves the page but
mishandles the socket produces precisely this.

### Audio and video work, but answer options or chat do not

A data channel problem, not a network problem - the selectivity is the clue.
See [Web Client known issues](services/web_client.md#known-issue-answer-options-occasionally-not-arriving).
Confirm `usrsctp` is present:

```bash
docker compose logs janus | grep -i sctp
```

### Interviewer and participant never see each other

They are in different rooms. Confirm both opened the **same token**, and that
`roomIdFromString()` (web) and `RoomIdFromString()` (Unity) still agree - a change
to one is silent. See
[Token and room derivation](architecture.md#token-and-room-derivation).

### The interview runs perfectly but no data is logged

Almost certainly the API key.

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
     -H "X-API-KEY: $(grep X_API_KEY .env | cut -d= -f2)" \
     http://localhost:16481/logging/status
```

If that fails, check `docker compose logs database-api` for a MongoDB connection
error. Logging failures never interrupt a session, so this must be checked
proactively.

### Handshake fails on slow networks

`dtls_timeout` is raised to 1500 ms for exactly this. Headsets on congested wifi
can still exceed it; raise it further before assuming a deeper fault.

## Maintenance

### Rotating credentials

TURN credentials and the logging API key appear in several places, and **all of
them must change together**:

| Secret | Locations |
|---|---|
| TURN username/password | `coturn/turnserver.conf`, `janus/conf.d/janus.jcfg`, web client `settings.js` (needs a rebuild), Unity `WebCamClient.IceServers` |
| `X_API_KEY` | `.env`, Unity Va.Si.Li API asset |
| Room secrets | `janus/conf.d/janus.plugin.videoroom.jcfg` |

TURN credentials ship to every browser and are public by construction. Rotate on
a schedule, not only after an incident.

### Updating Janus

The version is pinned by `JANUS_TAG` in `.env`, and the image is built and
published by
[Janus-Gateway](https://github.com/texttechnologylab/Janus-Gateway). To move:

```bash
# edit JANUS_TAG in .env
docker compose pull janus
docker compose up -d janus
docker compose logs janus | grep -E "applied override|videoroom|textroom|WebSockets"
```

!!! danger "Never change the Janus version mid-study"
    Media handling differs between versions in ways that are hard to see and hard
    to undo. Keep one version for the duration of a data collection period, and
    record which one produced which sessions.

### Log volume

`debug_level = 6` is verbose and appropriate while stabilising a deployment. For
steady-state running, lower it to `4` in `janus.jcfg`.
