# InterView

**A platform for conducting survey interviews in virtual reality.**

📖 **[Documentation](https://texttechnologylab.github.io/InterView/)**

An interviewee wears a VR headset and sits across from an avatar in a shared
virtual room; the interviewer sits at an ordinary web browser. The two are
connected by a live audio/video link, and everything that happens - speech, gaze,
posture, hand movement, answers given - is recorded in a single, time-aligned
data set.

Built at the [Text Technology Lab](https://www.texttechnologylab.org/) for the
**FACES** project (*Feasibility, acceptance, and data quality of new multimodal
surveys*, [DFG 539621548](https://gepris.dfg.de/gepris/projekt/539621548?language=en)),
part of DFG SPP 2431 [New Data Spaces](https://www.new-data-spaces.de/en-us/).

## What's in this repository

| Path | Contents |
|---|---|
| `docker-compose.yml` | The full service stack |
| `janus/conf.d/` | The two Janus config files InterView overrides |
| `coturn/` | TURN server configuration |
| `website/` | Web client source (interviewer console and browser participant view) |
| `docs/` | Documentation source (MkDocs Material) |

## Quick start

```bash
git clone https://github.com/texttechnologylab/InterView.git
cd InterView
cp .env.example .env      # fill in MongoDB credentials and an API key
docker compose up -d
```

**Read the [Setup Guide](https://texttechnologylab.github.io/InterView/setup/)
before deploying** - the stack requires an external MongoDB and a TLS-terminating
reverse proxy, and will not work without them.

## Services

| Service | Role |
|---|---|
| **Janus** | WebRTC SFU - audio/video plus the control data channel. Image from [Janus-Gateway](https://github.com/texttechnologylab/Janus-Gateway) |
| **coturn** | TURN relay *(optional)* |
| **Ubiq** | VR room and avatar state synchronisation |
| **Logging API** | Tracking data and events → MongoDB |
| **Web client** | Interviewer console and browser participant view. Source in `website/` |

## Related repositories

| Repository | Contains |
|---|---|
| [Va.Si.Li-Lab](https://github.com/texttechnologylab/Va.Si.Li-Lab) | The VR client and the framework it is built on |
| [Va.Si.Li-Lab-backend](https://github.com/texttechnologylab/Va.Si.Li-Lab-backend) | Ubiq server and database/logging API sources |
| [Janus-Gateway](https://github.com/texttechnologylab/Janus-Gateway) | The pinned Janus image this stack runs |

Unity and VR-side documentation lives in the
[Va.Si.Li-Lab docs](https://texttechnologylab.github.io/Va.Si.Li-Lab/).

## Citation

For InterView, please cite:
```bibtex
@misc{Schrottenbacher:et:al:2026,
  title        = {{InterView}: Towards a Unified {VR}-Capable Interview Environment},
  author       = {Schrottenbacher, Patrick},
  year         = {2026},
  note         = {Preprint},
  howpublished = {SSRN},
  doi          = {10.2139/ssrn.XXXXXXX},
  url          = {https://ssrn.com/abstract=XXXXXXX}
}
```

For the Virtual Reality Platform (Va.Si.Li-Lab), please cite:
```bibtex
@inproceedings{Mehler:et:al:2023:a,
  author    = {Mehler, Alexander and Bagci, Mevl{\"u}t and Henlein, Alexander
               and Abrami, Giuseppe and Spiekermann, Christian and Schrottenbacher, Patrick
               and Konca, Maxim and L{\"u}cking, Andy and Engel, Juliane and Quintino, Marc
               and Schreiber, Jakob and Saukel, Kevin and Zlatkin-Troitschanskaia, Olga},
  title     = {A Multimodal Data Model for Simulation-Based Learning with Va.Si.Li-Lab},
  booktitle = {Digital Human Modeling and Applications in Health, Safety, Ergonomics and Risk Management},
  publisher = {Springer Nature Switzerland},
  address   = {Cham},
  pages     = {539--565},
  year      = {2023},
  doi       = {10.1007/978-3-031-35741-1_39}
}
```
