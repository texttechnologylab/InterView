import { state, myroom, myroomLabel, IS_INTERVIEWER } from './state.js';
import { appendChatMessage, openChatPanel } from './chat.js';
import { renderAnswerOptions, handleAnswerAck, buildAnswerAck, repushLatestAnswerOptions } from './answer-options.js';
import { handleFollowUpSurvey } from './followup.js';
import { handleGazeOverlayMessage } from './gaze-overlay.js';
import { snapshotHandleStats } from './diagnostics.js';
import { updateRecordingUI, broadcastRecordingState } from './recording.js';

// Recovery state for textroom. The DataChannel PeerConnection can fail at the
// DTLS handshake (e.g. TURN-relay path dropping handshake packets) — when that
// happens Janus reports webrtcState(false). Recovery is fully self-contained to
// the textroom HANDLE: we detach the broken handle and re-attach a fresh one,
// which renegotiates a brand-new DataChannel PeerConnection. The video/audio
// PeerConnections live on separate handles and are never touched.
//
// The recovery shape depends on whether chat EVER connected this session:
//
//   • INITIAL CONNECT (never connected yet): the chat couldn't come up at all.
//     Fast-retry a few times, then fall back to the blocking "please reload"
//     modal — the original behavior. If the very first negotiation won't work,
//     a reload (fresh Janus session) is the right escalation.
//
//   • MID-SESSION DROP (was connected, then dropped): the call is healthy and
//     chat worked before, so be patient and non-intrusive — fast retries, then
//     slow background retries with a small banner (no reload). BUT cap the slow
//     phase: after SLOW_PHASE_MAX_MS of failures we give up and show the reload
//     modal too, so a permanently-wedged channel still gets resolved eventually.
const FAST_RETRIES = 6;
const SLOW_RETRY_INTERVAL_MS = 15000;
const SLOW_PHASE_MAX_MS = 2 * 60 * 1000; // give up slow retries after 2 min

// Negotiation deadlines.
//
// The textroom needs ICE + DTLS + SCTP + two application round trips (create,
// join) before it counts as ready — four to six more round trips than a media
// PeerConnection, which is why it is the only connection that fails on marginal
// networks while audio/video sail through. A fixed wall-clock deadline made that
// worse rather than better: it killed slow-but-healthy negotiations moments
// before they'd have succeeded, and the retry costs strictly more than the wait
// did (fresh TURN allocation, fresh DTLS handshake, fresh SCTP association). On
// a path that consistently needed slightly longer than the deadline, that never
// converged — every attempt was cut off just short of success.
//
// So the deadline is now progress-based:
//   • NO_PROGRESS_TIMEOUT_MS fires only when nothing has advanced for a while.
//     Every observed milestone rearms it, so a slow path gets as long as it
//     needs as long as it keeps moving.
//   • ABSOLUTE_TIMEOUT_MS is the backstop for a path that keeps emitting
//     progress but never actually completes.
const NO_PROGRESS_TIMEOUT_MS = 20000;
const ABSOLUTE_TIMEOUT_MS = 45000;

// Per-request retransmission for the two application round trips. Losing just
// the join response used to cost an entire PeerConnection rebuild; it now costs
// one round trip.
const REQUEST_TIMEOUT_MS = 4000;
const REQUEST_TRIES = 3;

let retryCount = 0;
let attaching = false;
let progressTimer = null;
let absoluteTimer = null;
let chatBanner = null;
let chatErrorModal = null;
let hasEverConnected = false; // flips true on first successful join
let slowPhaseStartedAt = 0;   // timestamp the slow phase began (0 = not started)

// Generation counter for textroom handles. Every attach bumps it and captures
// the value; every callback compares before touching shared state. Without this
// guard a superseded handle can wreck the handle that replaced it: detach()
// fires the old handle's oncleanup SYNCHRONOUSLY (janus.js cleanupWebrtc), and
// that handler used to reset chatReady unconditionally — leaving a freshly
// joined, perfectly healthy channel marked "not ready" with no further event
// coming to trigger a retry. Silently wedged chat, no error anywhere.
let handleGen = 0;

// Answer-option de-duplication state (interviewee side).
//
// `seq` is a CONTENT revision, not a packet counter: retries, the heartbeat and
// rejoin re-pushes all carry the seq of the batch they are re-delivering, so a
// duplicate is dropped (no DOM churn, no scroll reset) while a first delivery
// still renders.
//
// `epoch` identifies the sender's page load. The interviewer's counter restarts
// at zero when they reload, so without resetting on an epoch change every batch
// after an interviewer reload would be discarded as "stale" — and still acked,
// showing the interviewer a green confirmation for something we never displayed.
let lastAnswerSeq = -1;
let lastAnswerEpoch = null;

function clearNegotiationTimers() {
	if (progressTimer) {
		clearTimeout(progressTimer);
		progressTimer = null;
	}
	if (absoluteTimer) {
		clearTimeout(absoluteTimer);
		absoluteTimer = null;
	}
}

// Rearm the no-progress deadline. Called from every negotiation milestone, so a
// connection that is still advancing is never torn down.
function noteProgress(gen, what) {
	if (gen !== handleGen || state.chatReady) return;
	console.debug('[TEXTROOM] progress:', what);
	if (progressTimer) clearTimeout(progressTimer);
	progressTimer = setTimeout(
		() => onNegotiationStalled(gen, 'no-progress-after:' + what),
		NO_PROGRESS_TIMEOUT_MS
	);
}

function onNegotiationStalled(gen, reason) {
	if (gen !== handleGen || state.chatReady) return;
	console.warn('[TEXTROOM] negotiation stalled —', reason);
	clearNegotiationTimers();
	detachBrokenHandle(reason);
	attaching = false;
	scheduleRetry(reason);
}

function scheduleRetry(reason) {
	if (state.chatReady) return; // already recovered
	clearNegotiationTimers();
	retryCount += 1;

	// Fast phase: a few quick attempts with exponential backoff, silent.
	if (retryCount <= FAST_RETRIES) {
		const delay = Math.min(500 * Math.pow(2, retryCount - 1), 5000);
		console.warn('[TEXTROOM] fast retry #' + retryCount + ' in', delay, 'ms; reason=', reason);
		setTimeout(() => attachTextroom(), delay);
		return;
	}

	// Fast phase exhausted. If chat NEVER connected, this is an initial-connect
	// failure → fall back to the reload modal (original behavior). A reload gives
	// a fresh Janus session, which is the right fix when nothing ever negotiated.
	if (!hasEverConnected) {
		console.error('[TEXTROOM] initial connect failed after', retryCount, 'retries — prompting reload; reason=', reason);
		showChatErrorModal();
		return;
	}

	// Mid-session drop: the call is fine and chat worked before. Retry patiently
	// in the background with a banner — but not forever.
	if (!slowPhaseStartedAt) slowPhaseStartedAt = Date.now();
	if (Date.now() - slowPhaseStartedAt >= SLOW_PHASE_MAX_MS) {
		console.error('[TEXTROOM] slow phase exceeded', SLOW_PHASE_MAX_MS, 'ms — prompting reload; reason=', reason);
		hideChatBanner();
		showChatErrorModal();
		return;
	}
	console.warn('[TEXTROOM] slow retry #' + retryCount + ' in', SLOW_RETRY_INTERVAL_MS, 'ms; reason=', reason);
	showChatBanner();
	setTimeout(() => attachTextroom(), SLOW_RETRY_INTERVAL_MS);
}

function detachBrokenHandle(reason) {
	const h = state.textHandle;
	state.textHandle = null;
	state.chatReady = false;
	state.textTransactions = {};
	clearNegotiationTimers();
	// Retire this generation immediately. detach() below fires this handle's
	// oncleanup synchronously, and the server may still deliver hangup/ICE
	// events for it afterwards; from here on none of that may touch shared
	// state or the handle that replaces this one.
	handleGen += 1;
	if (!h) return;
	// Snapshot the failing PC's stats BEFORE detach destroys them, so the
	// diagnostic report can show what went wrong (failed candidate pairs,
	// DTLS state at moment of failure, etc.).
	snapshotHandleStats('textroom (data channel)', h, reason || 'unknown').finally(() => {
		try {
			h.detach({
				success: () => console.debug('[TEXTROOM] broken handle detached'),
				error: (e) => console.warn('[TEXTROOM] detach error (ignored)', e)
			});
		} catch (e) {
			console.warn('[TEXTROOM] detach threw (ignored)', e && e.message);
		}
	});
}

// Small non-blocking banner shown only once the fast retry phase is exhausted.
// It does NOT block the page — the video/audio call continues normally while the
// data channel keeps reconnecting in the background. Offers a manual "retry now"
// and, as a genuine last resort (not the default), a reload link.
function showChatBanner() {
	if (chatBanner) return;
	const banner = document.createElement('div');
	banner.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)] '
		+ 'bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 flex items-center gap-3';
	banner.innerHTML = `
		<i class="fas fa-circle-notch fa-spin text-orange-600"></i>
		<div class="flex-1 min-w-0">
			<p class="text-sm font-medium text-gray-800">Chat wird erneut verbunden…</p>
			<p class="text-xs text-gray-500">Das Interview läuft normal weiter.</p>
		</div>
		<button class="chat-banner-retry text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap">
			Jetzt versuchen
		</button>
	`;
	document.body.appendChild(banner);
	chatBanner = banner;
	banner.querySelector('.chat-banner-retry').addEventListener('click', () => {
		// Reset to the fast phase for an immediate, snappy attempt, and restart
		// the slow-phase clock so the user gets the full patient window again.
		retryCount = 0;
		slowPhaseStartedAt = 0;
		clearNegotiationTimers();
		attachTextroom();
	});
}

function hideChatBanner() {
	if (chatBanner) {
		chatBanner.remove();
		chatBanner = null;
	}
}

// Blocking "please reload" modal — the final escalation. Shown for an initial
// connect that never succeeded, or a mid-session drop that the slow phase
// couldn't recover within the time cap. Offers reload (fresh Janus session) and
// a manual retry that restarts the recovery ladder from the fast phase.
function showChatErrorModal() {
	hideChatBanner();
	if (chatErrorModal) return;
	const modal = document.createElement('div');
	modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm';
	modal.innerHTML = `
		<div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden border border-gray-200">
			<div class="px-6 py-8">
				<div class="flex justify-center mb-4">
					<div class="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center">
						<i class="fas fa-triangle-exclamation text-orange-600 text-lg"></i>
					</div>
				</div>
				<h2 class="text-xl font-semibold text-gray-900 text-center mb-2">Chat-Verbindung fehlgeschlagen</h2>
				<p class="text-gray-600 text-center text-sm">Der Chat konnte nach mehreren Versuchen nicht verbunden werden. Bitte laden Sie die Seite neu.</p>
			</div>
			<div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
				<button class="chat-error-reload flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors">
					Seite neu laden
				</button>
				<button class="chat-error-retry flex-1 px-4 py-2.5 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium text-sm transition-colors">
					Erneut versuchen
				</button>
			</div>
		</div>
	`;
	document.body.appendChild(modal);
	chatErrorModal = modal;
	modal.querySelector('.chat-error-reload').addEventListener('click', () => window.location.reload());
	modal.querySelector('.chat-error-retry').addEventListener('click', () => {
		modal.remove();
		chatErrorModal = null;
		retryCount = 0;
		slowPhaseStartedAt = 0;
		clearNegotiationTimers();
		attachTextroom();
	});
}

// Send a textroom request over the data channel and retransmit it if no response
// arrives. Each attempt gets a fresh transaction id but every id stays registered
// until one of them answers, so a slow response to an earlier attempt still
// resolves instead of being orphaned.
//
// This exists because losing a single application round trip used to be
// indistinguishable from a dead PeerConnection: the only safety net was the
// global negotiation deadline, which tore down ICE, DTLS and SCTP to recover
// from a lost 200-byte message.
function sendTrackedRequest(gen, build, onResponse, onGiveUp) {
	const ids = [];
	let attempt = 0;
	let timer = null;

	const cleanup = () => {
		if (timer) { clearTimeout(timer); timer = null; }
		for (const id of ids) delete state.textTransactions[id];
	};

	const attemptSend = () => {
		if (gen !== handleGen || !state.textHandle) return;
		attempt += 1;
		const payload = build();
		const tx = payload.transaction;
		ids.push(tx);
		state.textTransactions[tx] = (response) => {
			cleanup();
			if (gen !== handleGen) return;
			onResponse(response);
		};
		console.debug('[TEXTROOM] request', payload.textroom, 'attempt', attempt, 'tx=', tx);
		state.textHandle.data({
			text: JSON.stringify(payload),
			error: (reason) => console.warn('[TEXTROOM] request send error (will retry)', payload.textroom, reason)
		});
		timer = setTimeout(() => {
			if (gen !== handleGen) return;
			if (attempt >= REQUEST_TRIES) {
				console.warn('[TEXTROOM] request', payload.textroom, 'unanswered after', attempt, 'attempts');
				cleanup();
				onGiveUp();
				return;
			}
			console.warn('[TEXTROOM] request', payload.textroom, 'timed out — retransmitting');
			attemptSend();
		}, REQUEST_TIMEOUT_MS);
	};

	attemptSend();
}

export function attachTextroom() {
	if (attaching) {
		console.debug('[TEXTROOM] attachTextroom: already attaching, skipping duplicate');
		return;
	}
	if (state.textHandle) {
		console.debug('[TEXTROOM] attachTextroom: detaching old handle first');
		detachBrokenHandle('superseded-by-new-attach');
	}
	const gen = ++handleGen;
	attaching = true;
	state.chatReady = false;
	console.debug('[TEXTROOM] attachTextroom: requesting plugin attach (attempt', retryCount + 1,
		retryCount < FAST_RETRIES ? '[fast phase]' : '[slow phase]', ', gen=', gen, ')');

	clearNegotiationTimers();
	absoluteTimer = setTimeout(() => onNegotiationStalled(gen, 'absolute-timeout'), ABSOLUTE_TIMEOUT_MS);
	noteProgress(gen, 'attach-requested');

	state.janus.attach({
		plugin: 'janus.plugin.textroom',
		opaqueId: state.opaqueId,
		success: function (pluginHandle) {
			if (gen !== handleGen) {
				console.debug('[TEXTROOM] attach success for superseded gen=', gen, '— detaching immediately');
				try { pluginHandle.detach(); } catch (e) { /* already gone */ }
				return;
			}
			state.textHandle = pluginHandle;
			attaching = false;
			console.debug('[TEXTROOM] attached, handleId=', state.textHandle.getId(), '- sending setup');
			noteProgress(gen, 'plugin-attached');
			state.textHandle.send({ message: { request: 'setup' } });
		},
		error: function (error) {
			if (gen !== handleGen) return;
			console.error('[TEXTROOM] attach error', error && error.name, error && error.message, error);
			attaching = false;
			scheduleRetry('attach-error');
		},
		onmessage: function (msg, jsep) {
			if (gen !== handleGen) return;
			if (msg['error']) console.error('[TEXTROOM] message error', msg);
			if (jsep) {
				console.debug('[TEXTROOM] onmessage has jsep type=', jsep.type, '- creating answer');
				noteProgress(gen, 'offer-received');
				state.textHandle.createAnswer({
					jsep,
					tracks: [{ type: 'data' }],
					success: function (jsep) {
						if (gen !== handleGen) return;
						console.debug('[TEXTROOM] createAnswer success, sending ack');
						noteProgress(gen, 'answer-created');
						state.textHandle.send({ message: { request: 'ack' }, jsep });
					},
					error: function (error) {
						if (gen !== handleGen) return;
						console.error('[TEXTROOM] answer error', error && error.name, error && error.message, error);
						detachBrokenHandle('answer-error');
						scheduleRetry('answer-error');
					}
				});
			}
		},
		ondataopen: function () {
			if (gen !== handleGen) return;
			console.debug('[TEXTROOM] data channel open');
			noteProgress(gen, 'datachannel-open');
			// The interviewer owns the room, so it creates first (the room usually
			// does not exist yet at that point). The interviewee joins straight
			// away and only falls back to creating if the join fails — one round
			// trip less inside the negotiation deadline, which is the whole point.
			if (IS_INTERVIEWER) {
				createTextroom(gen, () => joinTextroom(gen, { triedCreate: true }));
			} else {
				joinTextroom(gen, { triedCreate: false });
			}
		},
		ondata: function (data) {
			if (gen !== handleGen) return;
			handleTextroomData(data);
		},
		oncleanup: function () {
			if (gen !== handleGen) {
				console.debug('[TEXTROOM] oncleanup from superseded gen=', gen, '— ignoring');
				return;
			}
			console.warn('[TEXTROOM] oncleanup fired — chatReady reset to false');
			state.chatReady = false;
		},
		webrtcState: function (on, reason) {
			if (gen !== handleGen) {
				console.debug('[TEXTROOM] webrtcState from superseded gen=', gen, '— ignoring');
				return;
			}
			console.debug('[TEXTROOM] webrtcState ->', on, 'reason=', reason);
			if (on === true) {
				noteProgress(gen, 'webrtc-up');
				return;
			}
			// DTLS timeout, ICE failure, or normal teardown after a failure.
			// If chatReady never flipped true, this is a setup failure → retry.
			// If chatReady was true and now we're down, the data channel died
			// mid-session → also retry to recover the channel.
			const wasReady = state.chatReady;
			detachBrokenHandle('webrtc-down:' + (reason || ''));
			if (wasReady) {
				console.warn('[TEXTROOM] data channel died mid-session — re-attaching');
				retryCount = 0;        // mid-session recovery, fresh fast budget
				slowPhaseStartedAt = 0; // and a fresh patient (slow) window
			}
			scheduleRetry('webrtc-down:' + (reason || ''));
		},
		iceState: function (s) {
			if (gen !== handleGen) return;
			console.debug('[TEXTROOM] iceState ->', s);
			if (s === 'connected' || s === 'completed') {
				noteProgress(gen, 'ice-' + s);
				return;
			}
			// 'disconnected' is NOT 'failed' — it frequently recovers on its own,
			// and tearing the PeerConnection down there costs a full rebuild for
			// what is often a momentary blip. Only act on a terminal failure.
			if (s === 'failed') {
				console.warn('[TEXTROOM] ICE failed — forcing retry');
				detachBrokenHandle('ice-failed');
				scheduleRetry('ice-failed');
			}
		}
	});
}

function createTextroom(gen, then) {
	console.debug('[TEXTROOM] createTextroom: creating room', myroom);
	sendTrackedRequest(gen, () => ({
		textroom: 'create',
		transaction: Janus.randomString(12),
		room: myroom,
		permanent: false,
		description: 'Interview ' + myroomLabel,
		history: 0
	}), (response) => {
		// "Room exists" is the normal outcome when the peer got there first;
		// every other error is also non-fatal, since the join that follows is
		// the real test of whether the room is usable.
		if (response['textroom'] === 'error') {
			console.debug('[TEXTROOM] create returned an error (continuing to join)', response);
		}
		then();
	}, () => {
		console.warn('[TEXTROOM] create unanswered — attempting join anyway');
		then();
	});
}

function joinTextroom(gen, opts) {
	const triedCreate = !!(opts && opts.triedCreate);
	state.myDisplayId = (IS_INTERVIEWER ? 'interviewer' : 'interviewee') + Janus.randomString(6);
	const displayId = state.myDisplayId;
	console.debug('[TEXTROOM] joinTextroom: joining as', displayId, 'triedCreate=', triedCreate);

	sendTrackedRequest(gen, () => ({
		textroom: 'join',
		transaction: Janus.randomString(12),
		room: myroom,
		username: displayId,
		display: state.myusername
	}), (response) => {
		if (response['textroom'] === 'error') {
			// Two recoverable causes look the same from here: the room may not
			// exist yet (the interviewee can reach this page before the
			// interviewer has created it), or our random username may have
			// collided with a lingering participant. Creating the room and
			// rejoining with a fresh username covers both, and doesn't depend on
			// plugin error codes, which differ across Janus versions.
			if (!triedCreate) {
				console.warn('[TEXTROOM] join failed — creating room and retrying', response);
				createTextroom(gen, () => joinTextroom(gen, { triedCreate: true }));
				return;
			}
			console.error('[TEXTROOM] join error', response);
			toastr && toastr.error('Chat: ' + (response.error || 'join failed'));
			detachBrokenHandle('join-error');
			scheduleRetry('join-error');
			return;
		}
		onJoined(gen, response);
	}, () => {
		console.error('[TEXTROOM] join unanswered after retransmits');
		detachBrokenHandle('join-unanswered');
		scheduleRetry('join-unanswered');
	});
}

function onJoined(gen, response) {
	if (gen !== handleGen) return;
	console.debug('[TEXTROOM] join success — chatReady = true');
	state.chatReady = true;
	hasEverConnected = true;
	clearNegotiationTimers();
	retryCount = 0;
	slowPhaseStartedAt = 0;
	hideChatBanner(); // recovered — remove the reconnecting banner if shown
	const input = document.getElementById('chat-input');
	if (input) input.removeAttribute('disabled');
	appendChatMessage({ system: true, text: 'Chat ready' });

	if (!IS_INTERVIEWER) return;

	// Our own channel just (re)connected — re-announce recording state so the
	// participant's REC indicator is correct even if the toggle happened while
	// this channel was down. The heartbeat keeps it converged afterwards.
	broadcastRecordingState();

	// Re-deliver whatever the participant should currently be seeing. This
	// covers two cases at once: a batch that was composed while our channel was
	// down, and a participant who has been sitting in the room the whole time
	// while we were the ones reconnecting.
	//
	// A textroom `join` event only reaches participants who are ALREADY in the
	// room, so if the interviewee got here first — or reconnected while our own
	// channel was down — we never saw theirs and the join-triggered re-push
	// below never fired. The join response's roster is the only way to notice.
	const participants = Array.isArray(response && response.participants) ? response.participants : [];
	const peerPresent = participants.some(
		(p) => p && typeof p.username === 'string' && p.username.startsWith('interviewee')
	);
	console.debug('[TEXTROOM] join roster:', participants.length, 'participant(s), interviewee present=', peerPresent);
	repushLatestAnswerOptions();
}

// Interviewee → interviewer: send an acknowledgement that a batch was received.
// Best-effort: if the channel isn't ready the interviewer's indicator simply
// times out to 'failed', which is the correct signal anyway.
function sendAnswerAck(msgId) {
	if (!state.textHandle || !state.chatReady) return;
	const message = {
		textroom: 'message',
		transaction: Janus.randomString(12),
		room: myroom,
		text: JSON.stringify(buildAnswerAck(msgId)),
		ack: false
	};
	try {
		state.textHandle.data({
			text: JSON.stringify(message),
			error: (reason) => console.warn('[TEXTROOM] ack send error', reason)
		});
	} catch (e) {
		console.warn('[TEXTROOM] ack send threw', e && e.message);
	}
}

// Resolve a clean name for the UI. The textroom username carries a random
// suffix (e.g. "interviewerAb12Cd"); never show that. Prefer the explicit
// display name, otherwise derive a role label from the username prefix.
function displayNameFor(username, display) {
	if (display) return display;
	if (typeof username === 'string' && username.startsWith('interviewer')) return 'Interviewer:in';
	if (typeof username === 'string' && username.startsWith('interviewee')) return 'Teilnehmer:in';
	return 'Teilnehmer:in';
}

// Render an incoming answer-option batch, dropping duplicates.
//
// Duplicates are expected and cheap by design: the interviewer retransmits an
// unacknowledged batch and re-announces the current one on a slow heartbeat, so
// a delivery lost while our channel was down still converges. We ack duplicates
// too — otherwise a lost ack (rather than a lost batch) would leave the
// interviewer's indicator stuck on "not confirmed" for options that are plainly
// on screen.
function handleAnswerOptionsPayload(payload) {
	const epoch = payload.epoch || null;
	if (epoch !== lastAnswerEpoch) {
		console.debug('[TEXTROOM] answer_options epoch changed', lastAnswerEpoch, '->', epoch, '— resetting seq guard');
		lastAnswerEpoch = epoch;
		lastAnswerSeq = -1;
	}
	const seq = typeof payload.seq === 'number' ? payload.seq : null;
	if (seq !== null && seq <= lastAnswerSeq) {
		console.debug('[TEXTROOM] duplicate answer_options seq=', seq, '— already rendered, acking only');
		if (payload.msgId) sendAnswerAck(payload.msgId);
		return;
	}
	if (seq !== null) lastAnswerSeq = seq;
	console.debug('[TEXTROOM] rendering answer_options seq=', seq, 'epoch=', epoch, 'msgId=', payload.msgId);
	renderAnswerOptions(payload.data);
	if (payload.msgId) sendAnswerAck(payload.msgId);
}

function handleTextroomData(raw) {
	let json;
	try { json = JSON.parse(raw); } catch (e) { return; }
	const tx = json['transaction'];
	if (tx && state.textTransactions[tx]) {
		state.textTransactions[tx](json);
		delete state.textTransactions[tx];
		return;
	}
	const what = json['textroom'];
	if (what === 'message') {
		const text = json['text'] || '';
		const fromUser = json['from'];
		const display = displayNameFor(fromUser, json['display']);
		if (fromUser === state.myDisplayId) return;
		let payload;
		try { payload = JSON.parse(text); } catch (e) { payload = null; }
		if (payload && payload.kind === 'answer_options') {
			if (!IS_INTERVIEWER) handleAnswerOptionsPayload(payload);
			return;
		}
		if (payload && payload.kind === 'ack') {
			// Interviewer-side: an interviewee confirmed receipt of a batch.
			if (IS_INTERVIEWER) handleAnswerAck(payload.ackOf);
			return;
		}
		if (payload && payload.kind === 'followup_survey') {
			if (!IS_INTERVIEWER) handleFollowUpSurvey(payload.url);
			return;
		}
		if (payload && payload.kind === 'gaze_overlay') {
			if (!IS_INTERVIEWER) handleGazeOverlayMessage(payload);
			return;
		}
		if (payload && payload.kind === 'recording') {
			// Interviewer told us whether the session is being recorded — mirror it
			// onto the interviewee's REC indicator.
			if (!IS_INTERVIEWER) {
				state.recording = !!payload.active;
				updateRecordingUI();
			}
			return;
		}
		appendChatMessage({ from: display, text });
		openChatPanel();
	} else if (what === 'announcement') {
		appendChatMessage({ system: true, text: json['text'] || '' });
	} else if (what === 'join') {
		const username = json['username'];
		const display = displayNameFor(username, json['display']);
		if (username !== state.myDisplayId) {
			appendChatMessage({ system: true, text: display + ' hat den Chat betreten' });
			// Push-on-join: when the interviewee joins (or rejoins after a reload),
			// the interviewer re-sends the latest answer-option batch so the
			// participant sees the current categories without manual resend.
			if (IS_INTERVIEWER && typeof username === 'string' && username.startsWith('interviewee')) {
				repushLatestAnswerOptions();
				// Catch a (re)joining participant up on the current recording state so
				// their REC indicator is correct even if they reloaded mid-recording.
				broadcastRecordingState();
			}
		}
	} else if (what === 'leave') {
		const display = displayNameFor(json['username'], json['display']);
		appendChatMessage({ system: true, text: display + ' hat den Chat verlassen' });
	}
}
