# InterView

**InterView** is a platform for conducting survey interviews in virtual reality. An
interviewee wears a VR headset and sits across from an avatar in a shared virtual
room; the interviewer sits at an ordinary web browser. The two are connected by a
live audio/video link, and everything that happens - speech, gaze, posture, hand
movement, answers given - is recorded in a single, time-aligned data set.

It was built at the [Text Technology Lab](https://www.texttechnologylab.org/) for
the **FACES** project (*Feasibility, acceptance, and data quality of new multimodal
surveys*, [DFG project 539621548](https://gepris.dfg.de/gepris/projekt/539621548?language=en)),
part of the DFG priority programme [SPP 2431 New Data Spaces](https://www.new-data-spaces.de/en-us/).

---

## Why it exists

Survey methodology has a measurement problem it cannot see. A telephone or web
survey records the answer and nothing else - not the hesitation before it, not
where the respondent was looking, not whether they understood the question. The
interaction that produced the answer is discarded, and with it most of the
evidence about whether the answer is any good.

InterView keeps that context. Because the interview happens inside a simulation,
every channel is observable at once and on a shared clock:

- what was **said**, by whom, and when
- where the respondent was **looking**, continuously
- **head, hand and body posture** throughout
- **facial expression**, via the headset's face tracking
- the **answers** themselves, and how long each one took

The research question is whether a VR-mediated interview is *feasible*, whether
respondents *accept* it, and whether the resulting *data quality* holds up against
conventional modes. The platform is the instrument that makes asking that
question possible.

## What has been built

<div class="grid cards" markdown>

-   :material-virtual-reality: **VR client**

    A Unity application for Meta Quest headsets. Renders the interview room and
    the interviewer's avatar, streams the participant's microphone, drives the
    embedded questionnaire, and logs every tracked channel.
    Built on [Va.Si.Li-Lab](https://github.com/texttechnologylab/Va.Si.Li-Lab).

-   :material-web: **Web client**

    Two browser pages - one for the interviewer, one as a non-VR fallback for the
    participant. Camera and microphone preview, device selection, virtual
    background, live chat, gaze overlay, answer options, and recording control.

-   :material-video-switch: **Media layer**

    A [Janus](https://janus.conf.meetecho.com/) SFU carrying audio and video
    between headset and browser, plus a data channel for control messages.
    Optional self-hosted TURN relay for difficult networks.

-   :material-database: **Data layer**

    A room/session server keeping VR state in sync, and a logging API that writes
    every sample and event into MongoDB for later analysis.

</div>

## How a session runs

1. A participant is issued a **token** - the identifier for their interview.
2. The token is entered in the VR client. It deterministically derives the media
   room, the VR room, and the questionnaire URL, so headset and browser meet in
   the same place without any coordination step. See
   [Token and room derivation](architecture.md#token-and-room-derivation).
3. The interviewer opens the same token in a browser and joins.
4. The interview is conducted. Audio and video flow through Janus; the
   interviewer can push answer options, start and stop recording, and follow the
   participant's gaze live.
5. Recordings land on the media server; all tracking and event data lands in
   MongoDB, keyed by the same token.

## Where to go next

| I want to… | Go to |
|---|---|
| Understand how the pieces fit together | [Architecture](architecture.md) |
| Deploy the whole stack from scratch | [Setup Guide](setup.md) |
| Configure the media server | [Janus](services/janus.md) |
| Set up a TURN relay | [coturn](services/coturn.md) |
| Build and configure the VR client | [VR Client](services/vr_client.md) |
| Retrieve recordings, or debug a session | [Operations](operations.md) |

!!! note "Two documentation sites"
    Documentation for the **VR client itself** - Unity setup, scenes, avatars,
    tracking, the Va.Si.Li-Lab framework InterView is built on - lives in the
    [Va.Si.Li-Lab documentation](https://texttechnologylab.github.io/Va.Si.Li-Lab/).
    Everything about the **InterView platform and its services** is here.

## Citation

InterView builds on Va.Si.Li-Lab. If you use it, please cite:

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
