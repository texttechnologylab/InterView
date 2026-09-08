# coturn

[coturn](https://github.com/coturn/coturn) is a TURN relay. **Optional**: it only
matters when two clients cannot reach each other directly.

## When you need it

WebRTC tries direct connection first, then STUN-discovered addresses, and only
falls back to a relay when both fail. That fallback is needed more often than
expected:

- **Symmetric NAT** - common on university, hospital and hotel networks
- **Restrictive firewalls** that drop inbound UDP from unknown sources
- **Mobile networks** behind carrier-grade NAT

A VR headset on institutional wifi is squarely in this category, which is why the
FACES deployment self-hosts one. If your clients are on a permissive network, or
you already have TURN infrastructure, skip this service.

!!! info "Two independent TURN configurations"
    TURN is configured in **two** places and both matter:

    - **Client-side** (`settings.js`, Unity `WebCamClient.IceServers`) - lets
      clients gather relay candidates for themselves.
    - **Server-side** (`turn_server` in `janus.jcfg`) - lets Janus do the same.

    Setting only one leaves a one-directional failure that is painful to diagnose.

## Ports

| Purpose | Port | Notes |
|---|---|---|
| Listening | `13478` | Public `3478` is mapped down by the firewall, so coturn runs unprivileged |
| Relay range | `50000-51000/udp` | Must be open, and **must not overlap Janus's `rtp_port_range`** |
| TLS | `5349` | Not enabled by default |

## Configuration

`coturn/turnserver.conf`. Deployment-specific values:

| Setting | Meaning |
|---|---|
| `listening-ip` / `relay-ip` | The host's own address |
| `external-ip=PUBLIC/PRIVATE` | Required behind 1:1 NAT - advertise the routable address. Drop the pair form if the host has a public IP directly |
| `realm` | Your TURN hostname |
| `user=name:password` | Static long-term credential |
| `min-port` / `max-port` | Relay range |

## Security

!!! danger "Review the peer policy before exposing this publicly"
    The shipped configuration is what the FACES deployment ran with, and it is
    permissive:

    ```ini
    allowed-peer-ip=0.0.0.0-255.255.255.255
    allow-loopback-peers
    allow-localhost-peers
    allow-local-ip
    ```

    This permits relaying to **any** address, including loopback and the host's own
    network. Combined with static credentials that necessarily ship to every
    browser in `settings.js`, anyone who reads the page source can relay arbitrary
    traffic through your network and reach internal services.

    For anything beyond a controlled study, you should:

    1. Remove the loopback and local-IP allowances unless something specifically
       needs them.
    2. Narrow `allowed-peer-ip` to the ranges you actually relay to.
    3. Replace static credentials with `use-auth-secret` and time-limited tokens,
       so a leaked credential expires on its own.
    4. Rotate the static credential on a schedule regardless.

## Verifying

Test from **another machine** - a test from the host proves nothing about NAT
traversal.

```bash
turnutils_uclient -T -u <username> -w <password> <public IP> -p 3478
```

Or use the [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
enter the TURN URL and credentials, and confirm at least one candidate of type
**`relay`** appears. If only `host` and `srflx` candidates show, TURN is not
working - check the firewall and the `external-ip` line first.

```bash
docker compose logs -f coturn
```
