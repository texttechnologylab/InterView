# Janus

[Janus](https://janus.conf.meetecho.com/) is the WebRTC SFU at the centre of
InterView. It carries audio and video between the VR headset and the
interviewer's browser, hosts the control data channel, and writes recordings.

!!! info "The image lives in its own repository"
    InterView consumes a prebuilt, pinned Janus image from
    **[texttechnologylab/Janus-Gateway](https://github.com/texttechnologylab/Janus-Gateway)**
    ([docs](https://texttechnologylab.github.io/Janus-Gateway/)). Nothing is
    compiled here.

    That repository documents the gateway itself - how configuration layering
    works, every setting, and how to rebuild or change the Janus version. **This
    page covers only what InterView overrides and why.**

- **Version:** 1.4.2, pinned by the `JANUS_TAG` variable in `.env`
- **Network mode:** host - required, see [Architecture](../architecture.md#network-ports)

## How configuration works here

The image ships Janus's stock configuration. InterView mounts
`janus/conf.d` at `/etc/janus.d`, and the image's entrypoint copies those files
over the matching defaults before Janus starts.

```yaml
volumes:
  - ./janus/conf.d:/etc/janus.d:ro
```

InterView therefore carries **two** files, not the whole config set:

| File | Why it is overridden |
|---|---|
| `janus.jcfg` | Networking, NAT, ICE and TURN - all deployment-specific |
| `janus.plugin.videoroom.jcfg` | Raises the video bitrate cap |

Everything else - the textroom plugin, both transports, every other plugin - is
**byte-identical to stock Janus**, so it is not carried here at all.

!!! danger "An override replaces a whole file - it does not merge"
    Janus config files have no include mechanism. `janus.jcfg` in `conf.d` is a
    complete copy of the default with a handful of lines changed, not a fragment.
    When updating, start from the shipped default:

    ```bash
    docker run --rm ghcr.io/texttechnologylab/janus-gateway:1.4.2 \
        cat /opt/janus/etc/janus/janus.jcfg > janus/conf.d/janus.jcfg
    ```

Confirm the overrides were picked up:

```bash
docker compose logs janus | grep "applied override"
```

## What InterView changes

### `janus.jcfg`

| Setting | Value | Why |
|---|---|---|
| `interface` | `eth0` | Bind ICE to the real interface |
| `ice_enforce_list` | `eth0` | Only gather candidates there; stops useless candidates from virtual interfaces |
| `nat_1_1_mapping` | `CHANGEME_PUBLIC_IP` | **Advertise the public IP.** Behind 1:1 NAT, without this Janus offers a private address and no external client can connect |
| `keep_private_host` | `false` | Suppress the private address in SDP once 1:1 mapping is set |
| `rtp_port_range` | `20000-20100` | Narrow, firewall-friendly range. **Only 100 ports - see below** |
| `full_trickle` | `true` | Faster connection setup |
| `dtls_timeout` | `1500` | Raised from 500 ms. Headsets on wifi are slow enough to lose the DTLS handshake at the default |
| `ipv6` / `ipv6_linklocal` | `true` | Dual-stack clients |
| `turn_server` / `turn_port` | `CHANGEME_TURN_HOST` / `13478` | Server-side TURN |
| `debug_level` | `6` | Verbose. Lower to `4` to cut log volume |

!!! warning "The RTP port range is narrow, and is a known open item"
    100 ports is enough for a single two-party interview, but it is shared by
    every concurrent session. The web client's own root-cause analysis of
    intermittent data-channel failures lists **widening this range as required
    before broader production use**, on the grounds that a narrow range lets one
    struggling session degrade others.

    If you expect concurrent interviews, widen it - the Janus stock default is
    `20000-40000` - and open the matching range in the firewall. Keep it clear of
    coturn's relay range (`50000-51000`).

!!! danger "`nat_1_1_mapping` is the setting that breaks deployments"
    If it holds a stale or wrong address, everything *looks* fine - Janus starts,
    the API answers, clients attach - and then no media ever flows. Check it
    first whenever a session connects but stays silent.

### `janus.plugin.videoroom.jcfg`

| Setting | Value | Why |
|---|---|---|
| `bitrate` | `328000` | Raised from the stock 128000, which is too low for a legible view of a face |

### Values to change for a new deployment

```
janus/conf.d/janus.jcfg
  interface, ice_enforce_list   -> your interface   (ip -br addr)
  nat_1_1_mapping               -> your public IP
  turn_server, turn_port        -> your TURN server
  turn_user, turn_pwd           -> replace CHANGEME_*

janus/conf.d/janus.plugin.videoroom.jcfg
  secret                        -> replace CHANGEME_ROOM_SECRET
```

```bash
grep -rn "CHANGEME_" janus/conf.d coturn
```

## Plugins InterView uses

Both clients attach **two** handles to the same room:

| Plugin | Role |
|---|---|
| `janus.plugin.videoroom` | The audio/video call itself |
| `janus.plugin.textroom` | Control bus - recording, answer options, gaze, chat |

!!! warning "These fail independently"
    `textroom` needs working WebRTC data channels; `videoroom` does not. A data
    channel fault produces a session where the participant sees and hears the
    interviewer perfectly while **no answer options ever appear**. That
    selectivity is the diagnostic - see
    [Web Client](web_client.md#known-issue-answer-options-occasionally-not-arriving).

## Rooms

Rooms are **created dynamically** by whichever client joins first - the room ID is
derived from the participant token, so no room needs to be pre-declared.

No `admin_key` is set, which means **any client that can reach Janus can create a
room**. Acceptable behind a restricted proxy; set one if Janus is reachable more
widely.

## Recordings

Janus writes `.mjr` files to `/mnt/recordings`, bind-mounted from
`RECORDINGS_DIR`. Recording is toggled by the interviewer at runtime, not by a
config flag. Conversion is covered in
[Operations](../operations.md#recordings), and in more depth in the
[gateway's recording docs](https://texttechnologylab.github.io/Janus-Gateway/recordings/).

## Operations

```bash
docker compose pull janus                    # update to a new JANUS_TAG
docker compose logs -f janus                 # follow logs
docker compose restart janus                 # apply a config change
curl -s http://localhost:8088/janus/info     # version, plugins, transports
```

Config changes require a restart - Janus does not reload them. Restarting drops
any call in progress, so never do it mid-interview.
