# VR Client

The Unity application the participant wears. It renders the interview room and
the interviewer's avatar, streams microphone audio, presents the questionnaire,
and logs every tracked channel.

Source: [Va.Si.Li-Lab](https://github.com/texttechnologylab/Va.Si.Li-Lab) ·
Target: Meta Quest

!!! info "Setup is documented in the Va.Si.Li-Lab docs"
    Unity project setup, the editor version, scenes, avatars, tracking, building
    for Quest, and the full component configuration for InterView live at
    **[InterView VR Client](https://texttechnologylab.github.io/Va.Si.Li-Lab/getting_started/interview_client/)**
    in the Va.Si.Li-Lab documentation.

    This page covers only how the client fits into the platform - what it talks
    to, and the two contracts that span repositories.

## What it connects to

Four independent services. Each is configured separately, and each can fail
without the others noticing.

| Service | Purpose | Configured in |
|---|---|---|
| [Janus](janus.md) | Audio/video and the control data channel | `WebCamClient` |
| [Ubiq](ubiq.md) | VR room and avatar state | `RoomClient` connection definition |
| [Logging API](logging_api.md) | Tracking data and events | Va.Si.Li API asset |
| Questionnaire | The survey instrument | `InterviewTokenManager` |

The VR client is a peer of the [web client](web_client.md), not a special case:
both join the same Janus room, both attach the videoroom and textroom plugins,
and either can be swapped for the other. That is what makes a browser usable as a
non-VR participant view and as the simplest way to test a deployment.

## Cross-repository contracts

Two things must agree across repositories. Both fail silently, which is why they
are called out here rather than left in the setup instructions.

### 1. Token derivation must match the web client

`InterviewTokenManager.RoomIdFromString()` (Unity) and `roomIdFromString()` in
`js/state.js` (web) implement the same function:

```
numeric token          -> parsed as an integer
anything else          -> DJB2 hash (seed 5381, ×33), absolute value, minimum 1
```

!!! danger "If they diverge, the interview splits in two"
    Interviewer and participant join **different rooms**. Each waits alone, no
    error is shown, and nothing in the logs says why. Change both or neither.

See [Token and room derivation](../architecture.md#token-and-room-derivation).

### 2. The logging API key must match the server

The key set in the Unity API asset must equal `X_API_KEY` in the server's `.env`.

!!! warning "A mismatch loses the session without interrupting it"
    Logging failures do not stop an interview. The session runs normally and
    records nothing. Verify data is arriving before a participant sits down -
    see [Logging API](logging_api.md#authentication).

## Endpoints the client needs

| Setting | Points at | Default port |
|---|---|---|
| `WebCamClient.ServerUrl` | Janus, via the TLS proxy - `wss://` | 8188 behind the proxy |
| `RoomClient` connection | Ubiq TCP | 16485 |
| API asset `host` | Logging API, via the proxy | 16481 |
| `InterviewTokenManager.BrowserBaseUrl` | Your questionnaire | - |
| `WebCamClient.RecordingPath` | `/mnt/recordings/` *inside the Janus container* | - |
