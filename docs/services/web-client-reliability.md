# Answer options not arriving — root-cause analysis & action list

Analysis focused on the lead problem: *"the answer options sometimes don't show
up for the other participant."*

**Revision 4** — the client-side fixes are now **implemented**. §2 documents the
cause as it stood before the fix (kept because it is the reasoning the fix rests
on and the thing to re-check if symptoms persist); §3 describes what shipped;
§6 tracks what is still open. Line references point at the **current** code
unless a heading says otherwise.

Earlier revisions incorporated the operator observations that the failure
(a) is random, (b) correlates with connection quality, and (c) **always affects
only the textroom/chat, never audio/video** — plus a review of the deployed
`janus.jcfg`. Port range triple-checked, MTU values adjusted, room handling
confirmed fine, `full_trickle` already enabled.

> **Status at a glance.** Client fixes: shipped, not yet validated against a
> live Janus. Server config (§6.2): not started — needed before this goes into
> production use, because widening `rtp_port_range` is what stops one struggling
> session from taking out others. Architecture change (§6.3): open decision.

!!! note "File paths in this document"
    Written against the web client as its own repository. Paths like
    `js/videoroom.js` are relative to `website/janus-html/` in InterView.

---

## 0. Summary

The decisive finding was the **selectivity**: same session, same TURN server,
same network — media works, the data channel doesn't. That is not a network
problem that happens to hit the textroom at random. In this codebase the
textroom was the only connection that

1. needs **4–6 additional round trips** (SCTP association + `create` + `join`), and
2. sat under a **hard 12-second deadline** that, on expiry, **discarded all
   progress** and restarted ICE from zero.

On a good network that's never a problem. On a marginal network it's a coin
flip — exactly the reported "random, depends on the connection." The media
PeerConnections have no such deadline and no application-level round trips; they
simply take as long as they take. That is why only the textroom failed.

**Core claim: the recovery machinery was the cause, not the cure.** The Janus
config then decides whether one marginal negotiation stays a single-session
hiccup or cascades across sessions (§6.2, item 8 — still open).

---

## 1. What the selectivity rules out

"Always only the textroom" is a strong datum that eliminates several hypotheses
on its own:

| Hypothesis | Ruled out because |
|---|---|
| coturn relay port range has gaps | would hit all three PeerConnections at random, not one selectively |
| coturn `user-quota` / `total-quota` | allocation order is publisher → **textroom** → subscriber; on quota exhaustion the **subscriber** would fail, not the textroom |
| missing `turns:443` candidate | would prevent the connection **entirely**, not selectively the data channel |
| `dtls_mtu` | already tuned; DTLS also affects all three PCs equally |
| room parameters / stale rooms | already verified |
| `seq` reset (C1, §4) | deterministic after an interviewer reload — neither random nor connection-dependent |
| filter substrings (C2, §4) | deterministic per question, not connection-dependent |

C1 and C2 were still real bugs and have been fixed — they were just **not** the
symptom seen in the field.

`turns:443` remains worthwhile for the *other* cases mentioned ("the connection
never comes up at all") — just not for this one.

---

## 2. The cause (as it stood before the fix)

Line references in this section point at the **pre-fix** code, kept so the
reasoning can be re-checked. The current implementation is §3.

### 2.1 What the textroom has to do extra

This part is unchanged by the fix — it is a property of the protocol, not of our
code, and it is why the textroom remains the most fragile of the three
connections even now.

| Step | Media PC (publisher) | textroom PC |
|---|---|---|
| WS attach → plugin | ✔ | ✔ |
| SDP exchange | client **offers** | Janus **offers**, client answers |
| ICE (incl. TURN allocation) | ✔ | ✔ |
| DTLS handshake | ✔ | ✔ |
| **SCTP association** (INIT / INIT-ACK / COOKIE-ECHO / COOKIE-ACK) | — | **+2 RTT** |
| **`create` request over the data channel** | — | **+1 RTT** |
| **`join` request over the data channel** | — | **+1 RTT** |
| counts as "ready" when … | packets flow | `chatReady = true` after the `join` response |

On a relayed path at 250 ms RTT that's roughly 1 s of pure added latency — plus
retransmission risk at every one of those steps. The DTLS handshake retransmits
with exponential backoff on loss; a single lost COOKIE-ECHO costs seconds.

### 2.2 The deadline that threw it all away

```js
const READY_TIMEOUT_MS = 12000;
readyTimer = setTimeout(() => {
    if (!state.chatReady) {
        detachBrokenHandle('ready-timeout');   // ← ICE, DTLS, SCTP: all discarded
        attaching = false;
        scheduleRetry('ready-timeout');        // ← from scratch
    }
}, READY_TIMEOUT_MS);
```

Three problems:

1. **The clock started at the `attach` request**, i.e. *before* ICE even began.
   The WS round trip, Janus's offer generation and Janus's own candidate
   gathering all counted against it.
2. **It was a wall-clock deadline, not a progress timeout.** A connection that
   completed its DTLS handshake at second 11 was destroyed at second 12 —
   despite demonstrably making progress.
3. **Retrying cost more than waiting.** Every retry meant a fresh TURN
   allocation, a fresh DTLS handshake, a fresh SCTP association and two fresh
   application round trips. On a path that consistently needed ~13 s this
   **never converged** — each attempt was cut off just before it would have
   succeeded.

What the user saw: 6 fast retries with backoff (0.5 / 1 / 2 / 4 / 5 / 5 s) plus
6 × 12 s of attempt time ≈ **90 seconds**, then — because `hasEverConnected` is
`false` on an initial connect — the blocking "please reload the page" modal. The
reload started the same sequence again.

### 2.3 One lost round trip cost a full PeerConnection rebuild

`create` and `join` registered their callbacks in `state.textTransactions` with
**no timeout of their own**. If *only* the `join` response was lost, nothing
re-sent it; the global 12 s deadline expired and tore down an otherwise healthy
PeerConnection. Retrying the `join` costs one round trip; the old code paid ICE +
DTLS + SCTP + 2 RTT instead.

Compounding this, and **still true today**: `textHandle.data()` never reports an
error. `sendData()` in janus.js calls `callbacks.success()` even when the
DataChannel is not open — the message just lands in a `pending` array
([janus.js:1748-1762](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/janus.js#L1748-L1762)) that is discarded on
`detach()`. Any `error` callback passed to `.data()` is therefore decorative. The
ack timeout, the retry schedule and the heartbeat are the real safety nets.

### 2.4 Stale-handle callbacks

`detachBrokenHandle` defers the actual `detach()` behind an `await pc.getStats()`.
During that window the old handle was still registered in janus.js's
`pluginHandles` and its callbacks kept firing — against **shared module state**.

Confirmed in janus.js: `detach()` → `destroyHandle` → `cleanupWebrtc` →
`pluginHandle.oncleanup()`, synchronously
([janus.js:3217](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/janus.js#L3217)). The old `oncleanup` handler set
`state.chatReady = false` **unconditionally**, never checking which handle it came
from. Firing after a new handle had already joined left chat silently broken:
`chatReady` false, but no further `webrtcState`/`iceState` event coming to
trigger a retry. **Permanently wedged, with no error anywhere.** The same applied
to `webrtcState(false)` from an old handle, which called `detachBrokenHandle` and
destroyed the **new, healthy** handle.

The window is narrow (getStats is a few milliseconds) but it only opens when
retries are already running — i.e. on exactly the marginal connections in
question.

---

## 3. What shipped

All client-side items are implemented. Not yet validated against a live Janus —
see §5.

### 3.1 Negotiation no longer discards progress

[textroom.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/textroom.js), mirrored in
[chat.html](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/chat.html):

- **Progress timeout replaces the wall clock.** `noteProgress()` rearms a 20 s
  `NO_PROGRESS_TIMEOUT_MS` timer at every milestone — plugin attached, JSEP
  offer received, answer created, data channel open, `webrtcState(true)`, ICE
  connected/completed. A 45 s `ABSOLUTE_TIMEOUT_MS` backstops a path that keeps
  emitting progress but never completes. A slow-but-moving negotiation is now
  never cut off.
- **`iceState: 'disconnected'` no longer tears anything down.** Only `'failed'`
  does. `disconnected` recovers on its own more often than not.
- **Per-request retransmission.** `sendTrackedRequest()` retries `create` and
  `join` at 4 s, up to 3 attempts. Every attempt gets a fresh transaction id but
  all of them stay registered until one answers, so a slow response to an earlier
  attempt still resolves instead of being orphaned.
- **One round trip removed from the critical path.** The interviewee joins
  directly; the interviewer (who owns the room) still creates first. Any join
  error falls back to create-then-rejoin, which covers both "room doesn't exist
  yet" and a username collision without depending on plugin error codes that
  differ across Janus versions.
- **Handle-generation guard.** Every callback captures `gen` at attach and
  returns early if superseded. `detachBrokenHandle` retires the generation
  *before* calling `detach()`, so the synchronous `oncleanup` can no longer touch
  the handle that replaced it.

### 3.2 Delivery is now state, not an event

[answer-options.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/answer-options.js):

- **`epoch`** — a random per-page-load id. The receiver resets its de-duplication
  state when it changes, so an interviewer reload no longer causes every
  subsequent batch to be discarded as stale.
- **`seq` is now a content revision, not a packet counter.** Retries, the
  heartbeat and rejoin re-pushes all carry the revision of the batch they are
  re-delivering. Duplicates are dropped without re-rendering; a first delivery
  still gets through. This is what makes every redelivery path idempotent.
- **Retry until acked** at 2 / 5 / 10 s against a 20 s ack budget. Ack
  registration happens on the first *actual transmission*, not when the batch is
  composed — otherwise the budget burned down while the channel was still
  connecting and reported a failure for something never sent.
- **15 s heartbeat** re-announces the current batch, so state converges even if
  every retry was lost while the participant's channel was down.
- **Duplicates are acked too.** A lost *ack* (rather than a lost batch) used to
  leave the indicator stuck on "not confirmed" for options plainly on screen.
- **Roster check on our own join.** A textroom `join` event only reaches
  participants already in the room, so if the interviewee got there first — or
  reconnected while our channel was down — we never saw theirs. The join
  response's roster is the only way to notice.

### 3.3 Suppression is visible instead of silent

The unanchored `includes()` checks became anchored, named `SUPPRESSION_RULES`.
`'ja'` no longer matches "Jahre", `'euro'` no longer matches "Europa", `'ledig'`
no longer matches "lediglich"; `'gerät'` still matches "Gerätetyp" but not
"geraten". Verified against 24 strings covering every rule and every previous
false positive.

More importantly, a suppressed batch is no longer invisible to the interviewer:
it gets a tracked ack and a distinct chat notice naming the rule ("Als freie
Antwort angezeigt"). Previously `null` meant no `msgId`, no echo and no chip
update — **indistinguishable from "didn't arrive"**, which is what made the real
transport problem so hard to diagnose.

### 3.4 Publisher recovery

[videoroom.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/videoroom.js) gained `recoverPublisher()`: ICE
restart on attempts 1–2 (reuses the existing senders and camera, so a successful
one is invisible — no permission prompt, no LED flicker), full republish on 3–4,
then the error modal. Previously the publisher was the only handle with no
recovery at all: if its ICE failed the participant stopped sending and nobody
noticed, because the local preview keeps rendering from the local track.

### 3.5 Smaller fixes

- **Early `label_listing` buffer.** [interviewer.html](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/interviewer.html)
  sets `iframe.src` synchronously while parsing, but the module chain
  (`DOMContentLoaded` → `loadIncludes()` → `setupAnswerOptionListener`) resolves
  after two fetches. An inline `<head>` buffer holds early posts; the real
  listener drains it and nulls the buffer to signal handover.
- **Origin allowlist**, derived from the iframe's own `data-base-url` so it can
  never drift from the page actually embedded. Enforced, but **loudly** —
  rejection logs at `error` level and raises a toastr, because a silently
  rejected message is precisely the failure mode being eliminated.
- **`interview.js` deleted** (852 lines, loaded by neither page, contained a
  second `label_listing` handler). `package.json` `main` repointed.

---

## 4. The architecture question: "I don't see how else I'd do things"

Still open. Two serious alternatives to running three PeerConnections.

### Option A — move the data channel onto the existing videoroom PCs

The videoroom plugin supports `data` as a regular stream type:

1. Add a data track to `publishOwnFeed`'s `createOffer`: `tracks.push({ type: 'data' })`.
2. The publisher's `streams` array then contains a `type: 'data'` entry, which
   flows into the subscription automatically via `attachToPublishers`.
3. The subscriber **already** answers with `tracks: [{ type: 'data' }]`
   ([videoroom.js:895](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/videoroom.js#L895)) — currently a no-op
   because the offer carries no data m-line, so the plumbing is half-built.
4. Send via `state.sfutest.data({ text })`, receive via `ondata` on
   `state.remoteFeed`.

What it buys: no third PeerConnection, no extra ICE/DTLS/TURN allocation, no
`create`/`join` round trips (videoroom membership *is* the membership), and a
data path that is available by construction exactly when video is — which, by
the operators' own observation, is always. Presence also becomes stronger:
a publisher you are subscribed to is provably present.

Cost: chat, answer options, REC state, gaze overlay and follow-up all move to the
new channel (every payload is already `kind`-tagged, so mechanical). The channels
stop being independent — if video fails, data fails with it. Given "video never
fails," that trade collapses two failure domains into the one that works.

### Option B — take it off WebRTC entirely

A ~50-line WebSocket relay keyed by room ID, behind the nginx already in use.

The argument is substantive rather than technical: the answer options are
**protocol-critical**. If the participant can't see them the interview is
methodologically unusable, whereas a video stutter is survivable. That asymmetry
argues against carrying the most critical signal over the most fragile transport
in the stack.

Also: server-side state means a reconnecting participant is served the current
state, so the whole push-on-join / repush / heartbeat construction disappears; it
works even when WebRTC is fully blocked (an interview could still run by phone
with the questionnaire visible); and an ack/retry protocol is trivial over a
reliable transport rather than hand-rolled.

### How the `/chat` monitor changes the calculus

[chat.html](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/chat.html) is a media-less chat monitor: it attaches
**only** `janus.plugin.textroom`, never calls getUserMedia, and advertises that
on its join screen. It joins the same room via the same `roomIdFromString` hash,
so it sits on the same textroom as the interview pages.

**Option A hurts it.** In videoroom, data flows publisher → subscriber. Receiving
is fine — the monitor can join as `ptype: 'subscriber'` without publishing. But
to *send* it must become a publisher with a data-only track, which means it
occupies a publisher slot and appears in everyone's `publishers` list. The
interview pages would try to subscribe to it, and `assignSlot` hardcodes
`slot = 1` / `#remote1` — the UI assumes exactly one remote, so a third
participant collides with the peer's tile. Option A therefore grows from "one
line in the publisher offer" into "make the interview UI tolerate a third
participant." Keeping the textroom alive *only* for the monitor is not a way out:
it would be watching a channel the interview no longer uses.

**Option B helps it.** The monitor would connect to the same relay by room ID and
drop Janus entirely — no `janus.js`, no `adapter.min.js`, no ICE/DTLS/SCTP, no
retry ladder. Roughly 400 of its ~900 inline lines are WebRTC diagnostics that
stop being meaningful. It would also gain **history** (today `history: 0` means a
monitor joining mid-interview sees nothing that preceded it) and would work on
networks where WebRTC is blocked, which matters for a supervision tool likely
used from locked-down institutional networks.

**Recommendation:** if `/chat` is kept, **Option B**. More upfront work than
Option A, but the only one of the two that leaves the monitor simpler rather than
more entangled, and it removes WebRTC from the path of the one signal the study
protocol actually depends on. Choose Option A only if `/chat` is expendable or
you accept reworking the interview UI's slot handling.

---

## 5. Verification

### 5.1 What has been checked

Static only: all modules parse, every named import resolves to a real export, all
inline `<script>` blocks parse, and the suppression rules pass 24 cases covering
every rule and every previous false positive.

> ⚠️ `node --check` **silently returns 0 on files with syntax errors** in the
> Node v22.13 build on this machine (module-detection interaction). Use
> `vm.SourceTextModule` under `--experimental-vm-modules` instead, and always
> self-test the checker against a known-bad file first.

**Not yet validated against a live Janus.** The timeout, retry and recovery
behaviour needs a real session — ideally a deliberately degraded one.

### 5.2 Confirming the fix worked

The instrumentation is in place ([diagnostics.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/diagnostics.js):
500-line ring buffer plus a `getStats()` time series every 2 s). On a marginal
connection, look for:

| Expected after the fix | Meaning |
|---|---|
| `[TEXTROOM] progress: …` lines advancing through attach → offer → answer → datachannel-open → ice-connected | the negotiation is being given time instead of being cut off |
| `[TEXTROOM] request join timed out — retransmitting` followed by success | a lost round trip cost a round trip, not a rebuild |
| **absence** of `ready timeout reached after 12000 ms` | the old guillotine is gone |
| `[ANSWER-OPTIONS] no ack for seq=N … retransmitting` then an ack | retry-until-acked doing its job |
| `[TEXTROOM] duplicate answer_options seq=N — already rendered, acking only` | de-duplication working; harmless and expected |
| `[TEXTROOM] oncleanup from superseded gen=N — ignoring` | the stale-handle guard catching a real occurrence |

Still-bad signs, and what they'd mean:

- `[TEXTROOM] negotiation stalled — no-progress-after:…` repeatedly at the same
  milestone → the connection genuinely isn't advancing past that point. Look at
  the Janus DTLS/SCTP path, not the client.
- `txt` row showing `no-active-pair` or ICE `checking`/`failed` throughout, with
  no progress lines at all → ICE never completes; §6.2 and the TURN config.
- `[TEXTROOM] absolute-timeout` → progress kept being reported but the join never
  landed. That would be new information and worth a fresh look.

Collect reports from **both** sides. The marker that distinguishes these cases is
usually on the opposite side from where the symptom shows.

---

## 6. Still open

### 6.1 Client — done

| # | Change | Status |
|---|---|---|
| 1 | Progress timeout replacing the 12 s wall clock (20 s no-progress, 45 s absolute) | ✅ |
| 2 | Own timeouts for `create`/`join` via `sendTrackedRequest` (4 s, 3 attempts) | ✅ |
| 3 | Handle-generation guard in all textroom callbacks | ✅ |
| 4 | Interviewee skips `create`, joins directly with create-then-rejoin fallback | ✅ |
| 5 | `epoch` field on answer-option payloads | ✅ |
| 6 | Retry-until-acked + 15 s state heartbeat; `seq` as content revision | ✅ |
| — | Anchored suppression rules + visible "suppressed by rule X" echo | ✅ |
| — | Publisher ICE-restart recovery | ✅ |
| — | Early `label_listing` buffer + origin allowlist | ✅ |
| — | Deleted dead `interview.js` | ✅ |

Items 1–4 existed **twice** — once in [textroom.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/textroom.js),
once inline in [chat.html](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/chat.html). Both copies were fixed. **Keep
them in sync**: the monitor is a verbatim copy of the same negotiation logic, so
any future change to one belongs in the other.

### 6.2 janus.jcfg — not started

Item 8 matters most: it is what decides whether one struggling session stays
contained or cascades. Worth doing before this sees production use.

| # | Current | Target | Why |
|---|---|---|---|
| 8 | `rtp_port_range = "20000-20100"` | `"20000-20999"` (+ firewall) | 101 ports. libnice binds **one port per local address per PC**; with `ipv6` + `ipv6_linklocal` that's ≈3 ports/PC (check `ip addr show <interface>`). Six PCs per interview ≈ 18 ports → **~5 concurrent interviews**. The textroom is the only handle with a retry loop: each retry claims new ports while the old ones are still held, so one marginal connection can exhaust the range and take out **other** sessions' textrooms, which then retry as well. Media PCs claim their ports once and keep them — precisely why they never fail. Note the client fix makes each attempt *longer-lived*, so widening this is more important now, not less. |
| 9 | `ipv6_linklocal = true` | `false` | `fe80::/10` is never reachable by a remote browser. It burns ports from the tight range and creates candidate pairs that must time out before ICE settles. Keep `ipv6 = true`. |
| 10 | `turn_server`/`turn_port`/`turn_type`/`turn_user`/`turn_pwd` set | **remove** the block | The file's own comment says never set this unless Janus sits behind a restrictive firewall. With `nat_1_1_mapping = CHANGEME_PUBLIC_IP` that isn't the case. Right now **every** PeerConnection pays a TURN Allocate to `CHANGEME_PRIVATE_IP:13478` before gathering completes, and ships relay candidates the browser must additionally pair and check. |
| 11 | `debug_level = 6` | `4` | Level 6 is VERB; CPU and I/O per handle for no production benefit. |
| 12 | `dtls_timeout = 1500` | `1000` or remove | 1.5 s initial retransmit: one lost DTLS packet costs 1.5 s, two 4.5 s, three 10.5 s. Less acute now that the client deadline is progress-based, but still slow to recover. **Also:** per the file's own comment this only takes effect under BoringSSL; on OpenSSL builds it's fixed at 1 s and the line does nothing. The `info` endpoint reports the crypto library (`hide_dependencies` is not set). |
| 13 | `#dtls_mtu = 1200` (commented) | set explicitly | Still commented out here, so Janus runs the 1200 default — the MTU values adjusted evidently live elsewhere (coturn/interface). |

### 6.3 Architecture — decision open

| # | Change |
|---|---|
| 7 | Move the data path off its own PeerConnection. See §4 — the `/chat` monitor makes **Option B** the better choice. |

### 6.4 Separate, independent of this symptom

| # | Change |
|---|---|
| 14 | `turns:…:443?transport=tcp` in [settings.js](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/settings.js#L74-L78) — for the "connection never comes up at all" cases |
| 15 | Ephemeral TURN credentials (`use-auth-secret`). `CHANGEME_TURN_USER`/`CHANGEME_TURN_PASSWORD` appears both in a public JS file and in janus.jcfg |

### 6.5 Needs a product decision, not code

The `/chat` monitor registers under the `interviewer` username prefix, so the
participant sees "Interviewer:in hat den Chat betreten" when a supervisor opens
it, and monitor messages are indistinguishable from the interviewer's. The
monitor's own `displayNameFor` already anticipates a `monitor` prefix that
nothing produces, suggesting that was the original intent. Left as-is
deliberately — changing it alters what the participant sees.

### 6.6 Confidentiality — outside the chat bug, but urgent

`api_secret` is commented out, so the Janus WebSocket accepts unauthenticated
requests from anywhere. Room IDs come from a simple djb2 hash of the interview ID
([state.js:8-14](https://github.com/texttechnologylab/InterView/blob/main/website/janus-html/js/state.js#L8-L14)), and the videoroom `list`
request enumerates all rooms — so an unrelated party can list active rooms and
subscribe as a viewer to a live interview. For a study that records human
subjects to `/mnt/recordings`, this should be closed independently of the chat
bug. Also confirm the Admin API transport is not reachable from outside
(`admin_secret = "janusoverlord"`).
