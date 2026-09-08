import { state, myroom, myroomLabel, IS_INTERVIEWER } from './state.js';
import { escapeHtml } from './utils.js';
import { attachTextroom } from './textroom.js';
import { updateRecordingUI } from './recording.js';
import { startVirtualBg, stopVirtualBg, isVirtualBgActive, setVirtualBgMode } from './virtualbg.js';
import { snapshotHandleStats } from './diagnostics.js';

let creatingSubscription = false;
let subscriberRecoveryAttempts = 0;
const MAX_SUBSCRIBER_RECOVERY = 5;
let subscriberRecovering = false;
let roomWaitOverlay = null;
let roomWaitTimer = null;
let roomWaitAttempts = 0;
let webrtcErrorModal = null;
let localPreviewActive = false;
let publisherRecoveryAttempts = 0;
let publisherRecoveryTimer = null;
const MAX_PUBLISHER_RECOVERY = 4;

// Firefox needs the original-track-for-preview + clone-for-Janus split, because
// it refuses to render a track that a PeerConnection sender already holds. But
// that same clone BREAKS Chrome: on Chrome/Linux the H264 SimulcastEncoderAdapter
// silently never encodes a cloned track (framesEncoded stays 0 — interviewer sees
// nothing). So the clone workaround must be Firefox-only; Chrome gets the original
// track handed straight to Janus and renders the preview the normal way.
const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');

function ensureRoomWaitOverlay() {
	if (roomWaitOverlay) return roomWaitOverlay;
	const modal = document.createElement('div');
	modal.className = 'fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm hide';
	modal.innerHTML = `
		<div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden border border-gray-200">
			<div class="px-6 py-8">
				<div class="flex justify-center mb-4">
					<div class="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
						<i class="fas fa-spinner fa-spin text-blue-600 text-lg"></i>
					</div>
				</div>
				<h2 class="text-xl font-semibold text-gray-900 text-center mb-2">Bitte warten</h2>
				<p class="text-gray-600 text-center text-sm">Der Interviewer ist gleich bei Ihnen.</p>
				<p class="text-gray-600 text-center text-sm">Wir verbinden Sie, sobald der Raum bereit ist.</p>
			</div>
		</div>
	`;
	document.body.appendChild(modal);
	roomWaitOverlay = modal;
	return modal;
}

function showRoomWaitOverlay() {
	const modal = ensureRoomWaitOverlay();
	modal.classList.remove('hide');
}

function hideRoomWaitOverlay() {
	if (roomWaitOverlay) roomWaitOverlay.classList.add('hide');
	if (roomWaitTimer) {
		clearTimeout(roomWaitTimer);
		roomWaitTimer = null;
	}
	roomWaitAttempts = 0;
}

function scheduleRoomJoinRetry() {
	showRoomWaitOverlay();
	if (roomWaitTimer) return;
	const attempt = Math.min(roomWaitAttempts, 5);
	const delay = 1500 + (attempt * 1200);
	roomWaitAttempts += 1;
	roomWaitTimer = setTimeout(() => {
		roomWaitTimer = null;
		if (state.sfutest) joinVideoRoom(state.myusername);
	}, delay);
}

function showWebrtcErrorModal(error) {
	if (webrtcErrorModal) return;
	const message = error && (error.message || error.reason || error.toString());
	const safeMessage = message ? escapeHtml(message) : '';
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
				<h2 class="text-xl font-semibold text-gray-900 text-center mb-2">Verbindungsproblem</h2>
				<p class="text-gray-600 text-center text-sm">Die WebRTC-Verbindung konnte nicht aufgebaut werden.</p>
				<p class="text-gray-600 text-center text-sm">Bitte laden Sie die Seite neu. Falls Sie ein VPN nutzen, versuchen Sie es ohne VPN.</p>
				${safeMessage ? `<p class="text-xs text-gray-500 text-center mt-3">Details: ${safeMessage}</p>` : ''}
			</div>
			<div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
				<button class="webrtc-reload flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors">
					Seite neu laden
				</button>
				<button class="webrtc-close flex-1 px-4 py-2.5 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium text-sm transition-colors">
					Schliessen
				</button>
			</div>
		</div>
	`;
	document.body.appendChild(modal);
	webrtcErrorModal = modal;

	const reloadBtn = modal.querySelector('.webrtc-reload');
	const closeBtn = modal.querySelector('.webrtc-close');
	const closeModal = () => {
		modal.remove();
		webrtcErrorModal = null;
	};
	if (reloadBtn) reloadBtn.addEventListener('click', () => window.location.reload());
	if (closeBtn) closeBtn.addEventListener('click', closeModal);
}

export function teardownJanus() {
	// Destroy the whole session with the unload-safe path (sendBeacon), so the
	// media server frees our publisher slot immediately on reload instead of
	// waiting for an ICE timeout. janus.js registers this on 'beforeunload', but
	// that event is unreliable on mobile; 'pagehide' (where this runs) fires
	// reliably there, which matters for the quick-reload reconnect race.
	try {
		if (state.janus) state.janus.destroy({ unload: true, notifyDestroyed: false });
	} catch (e) { /* page is unloading; nothing actionable */ }
	try {
		if (state.preinterviewStream) {
			state.preinterviewStream.getTracks().forEach((t) => t.stop());
			state.preinterviewStream = null;
		}
	} catch (e) { /* ignore */ }
}

export function connectToJanus() {
	state.janus = new Janus({
		server: server,
		iceServers: iceServers,
			success: function () {
				console.debug('[VIDEOROOM] Janus.init success - attaching videoroom + textroom');
				attachVideoroomPublisher();
				attachTextroom();
			},
		error: function (error) {
			Janus.error(error);
			bootbox.alert('Verbindung zum Medienserver fehlgeschlagen: ' + error, function () {
				window.location.reload();
			});
		},
		destroyed: function () {
			window.location.reload();
		}
	});
}

// The publisher PeerConnection was the only path with no recovery of its own:
// the subscriber has recoverSubscriber() and the textroom has a full retry
// ladder, but if the publisher's ICE failed the participant simply stopped
// sending and nobody noticed — their own preview keeps rendering from the local
// track, so the failure is invisible on the sending side and looks like a frozen
// image on the receiving one.
//
// Escalate gently, cheapest first:
//   1-2. ICE restart — reuses the existing senders and camera, so a successful
//        one is completely invisible to the user (no permission prompt, no
//        camera LED flicker).
//   3-4. Full republish — re-acquires devices; disruptive but recovers cases an
//        ICE restart can't (e.g. the sender itself is wedged).
//   then. Tell the user, rather than pretending the call is still healthy.
function recoverPublisher(reason) {
	if (!state.sfutest) return;
	if (publisherRecoveryTimer) {
		console.debug('[VIDEOROOM] publisher recovery already scheduled, ignoring', reason);
		return;
	}
	publisherRecoveryAttempts += 1;
	const attempt = publisherRecoveryAttempts;
	if (attempt > MAX_PUBLISHER_RECOVERY) {
		console.error('[VIDEOROOM] publisher recovery exhausted after', attempt - 1, 'attempts; reason=', reason);
		showWebrtcErrorModal({ message: 'Die Medienverbindung ist abgebrochen (' + reason + ').' });
		return;
	}
	const delay = 1000 * attempt;
	console.warn('[VIDEOROOM] publisher recovery attempt', attempt, 'in', delay, 'ms; reason=', reason);
	publisherRecoveryTimer = setTimeout(() => {
		publisherRecoveryTimer = null;
		if (!state.sfutest) return;
		if (attempt <= 2) {
			console.debug('[VIDEOROOM] publisher: attempting ICE restart');
			state.sfutest.createOffer({
				iceRestart: true,
				success: function (jsep) {
					console.debug('[VIDEOROOM] publisher ICE restart offer created, sending configure');
					try {
						state.sfutest.send({
							message: { request: 'configure', audio: true, video: state.cameraEnabled },
							jsep
						});
					} catch (e) {
						console.error('[VIDEOROOM] publisher ICE restart configure threw', e && e.message);
					}
				},
				error: function (error) {
					console.error('[VIDEOROOM] publisher ICE restart failed',
						'name=', error && error.name, 'message=', error && error.message);
					recoverPublisher('ice-restart-failed');
				}
			});
		} else {
			console.warn('[VIDEOROOM] publisher: ICE restart did not recover — full republish');
			republishOwnFeed().catch((e) => {
				console.error('[VIDEOROOM] publisher republish failed', e && e.message);
				recoverPublisher('republish-failed');
			});
		}
	}, delay);
}

export function attachVideoroomPublisher() {
	state.janus.attach({
		plugin: 'janus.plugin.videoroom',
		opaqueId: state.opaqueId,
		success: onPublisherAttached,
		error: function (error) {
			Janus.error('Error attaching videoroom plugin', error);
			bootbox.alert('Fehler beim Anhängen des Videoroom-Plugins: ' + error);
		},
		consentDialog: function (on) {
			if (on) {
				$.blockUI({
					message: '<div class="p-4 bg-white rounded-lg"><i class="fas fa-microphone text-blue-600 text-2xl"></i> &nbsp;<b class="text-gray-800">Allow camera & microphone</b></div>',
					baseZ: 3001,
					css: { border: 'none', padding: '0', backgroundColor: 'transparent' }
				});
			} else {
				$.unblockUI();
			}
			console.debug('[VIDEOROOM] consentDialog ->', on);
		},
		webrtcState: function (on, reason) {
			Janus.log('Publisher PC is ' + (on ? 'up' : 'down'));
			console.debug('[VIDEOROOM] publisher webrtcState ->', on, reason || '');
			$('#videolocal').parent().unblock();
			// A PC that came up is a clean slate: forget earlier recovery attempts
			// so a later, unrelated failure gets the full escalation ladder again.
			if (on === true) publisherRecoveryAttempts = 0;
		},
		iceState: function (s) {
			console.debug('[VIDEOROOM] publisher iceState ->', s);
			if (s === 'connected' || s === 'completed') {
				publisherRecoveryAttempts = 0;
				return;
			}
			// 'disconnected' is not 'failed' — it recovers on its own more often
			// than not, and restarting ICE there would churn the connection for
			// what is usually a momentary blip. Only act on a terminal failure.
			if (s === 'failed') recoverPublisher('ice-failed');
		},
		onmessage: handlePublisherMessage,
		onlocaltrack: handleLocalTrack,
		onremotetrack: function () { /* publisher is sendonly */ },
		oncleanup: function () {
			console.debug('[VIDEOROOM] publisher oncleanup');
			snapshotHandleStats('publisher (videoroom)', state.sfutest, 'oncleanup');
			mystreamCleanup();
		}
	});
}

function mystreamCleanup() {
	console.debug('[VIDEOROOM] mystreamCleanup - clearing local tracks and UI');
	state.localTracks = {};
	state.localVideos = 0;
	state.activeLocalAudioTrackId = '';
	state.activeLocalVideoTrackId = '';
	$('#videolocal').empty();
}

// Dump a video track's live settings + constraints + capabilities. Used to
// diagnose the Firefox "outbound video stuck at 0x0, interviewer sees nothing"
// failure: if the track handed to Janus reports width/height 0 (or wildly small
// like 320x180 while the preview is 1280), the encoder never gets a usable frame.
function logTrackDetails(label, track) {
	try {
		if (!track) { console.debug('[VIDEOROOM] trackDetails[' + label + '] = null'); return; }
		const settings = track.getSettings ? track.getSettings() : {};
		const constraints = track.getConstraints ? track.getConstraints() : {};
		console.debug('[VIDEOROOM] trackDetails[' + label + ']',
			'id=', track.id,
			'kind=', track.kind,
			'readyState=', track.readyState,
			'enabled=', track.enabled,
			'muted=', track.muted,
			'label=', track.label,
			'| settings:', JSON.stringify({
				width: settings.width, height: settings.height, frameRate: settings.frameRate,
				deviceId: settings.deviceId, facingMode: settings.facingMode, resizeMode: settings.resizeMode
			}),
			'| constraints:', JSON.stringify(constraints));
	} catch (e) {
		console.warn('[VIDEOROOM] logTrackDetails error for', label, e && e.message);
	}
}

// Sample the publisher's outbound video encoder a few seconds after publishing.
// If frameWidth/framesEncoded stay at 0, the encoder never received a usable
// frame from the (cloned) track — that's the "interviewer sees nothing" bug.
function checkOutboundVideoHealth() {
	const sample = (atSeconds) => setTimeout(async () => {
		try {
			const pc = state.sfutest && state.sfutest.webrtcStuff && state.sfutest.webrtcStuff.pc;
			if (!pc) return;
			const stats = await pc.getStats(null);
			let found = false;
			stats.forEach((s) => {
				if (s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'video') {
					found = true;
					const healthy = (s.framesEncoded > 0) && (s.frameWidth > 0);
					console.debug('[VIDEOROOM] outbound-video health @' + atSeconds + 's:',
						healthy ? 'OK' : '!! ENCODER STALLED (0 frames) !!',
						'framesEncoded=', s.framesEncoded,
						'frameWidth=', s.frameWidth, 'frameHeight=', s.frameHeight,
						'fps=', s.framesPerSecond, 'bytesSent=', s.bytesSent,
						'qualityLimitationReason=', s.qualityLimitationReason,
						'encoder=', s.encoderImplementation);
				}
			});
			if (!found) console.debug('[VIDEOROOM] outbound-video health @' + atSeconds + 's: no outbound-rtp video stat yet');
		} catch (e) { /* ignore */ }
	}, atSeconds * 1000);
	sample(5);
	sample(12);
}

function stopLocalVideoTrack() {
	console.debug('[VIDEOROOM] stopLocalVideoTrack called; activeVideoId=', state.activeLocalVideoTrackId);
	try {
		const track = state.localTracks.video;
		if (track && typeof track.stop === 'function') track.stop();
	} catch (e) { console.warn('[VIDEOROOM] stopLocalVideoTrack stop error', e); }
	// If a separate preview track is showing in #myvideo (Firefox workaround), stop it too.
	try {
		const myV = document.getElementById('myvideo');
		const previewTrack = myV && myV.srcObject && myV.srcObject.getVideoTracks()[0];
		if (previewTrack && typeof previewTrack.stop === 'function') previewTrack.stop();
	} catch (e) {}
	localPreviewActive = false;
	delete state.localTracks.video;
	state.activeLocalVideoTrackId = '';
	state.localVideos = 0;
	$('#myvideo').remove();
}

function onPublisherAttached(pluginHandle) {
	state.sfutest = pluginHandle;
	Janus.log('Publisher attached, id=' + state.sfutest.getId());
	console.debug('[VIDEOROOM] onPublisherAttached id=', state.sfutest.getId());

	if (IS_INTERVIEWER) {
		ensureRoomExists(() => joinVideoRoom(state.myusername));
	} else {
		showRoomWaitOverlay();
		joinVideoRoom(state.myusername);
	}
}

function ensureRoomExists(then) {
	const create = {
		request: 'create',
		room: myroom,
		description: 'Interview ' + myroomLabel,
		rec_dir: '/mnt/recordings/' + myroomLabel + '/',
		publishers: 6,
		bitrate: 0,
		fir_freq: 4,
		audiocodec: 'opus',
		videocodec: 'h264,vp8',
		// Safari (iOS/iPadOS/macOS) offers H264 High profile (640c1f) first and Janus
		// accepts it per-publisher — but Firefox only negotiates Constrained Baseline
		// (42e01f), so a Firefox subscriber gets NO video m-line from a Safari
		// publisher (audio-only: "interviewer can't see interviewee"). Pinning the
		// room profile forces every publisher onto Baseline, which all browsers
		// offer and decode.
		h264_profile: '42e01f',
		notify_joining: false
	};
	state.sfutest.send({
		message: create,
		success: function (response) {
			Janus.log('videoroom create response', response);
			then();
		},
		error: function (err) {
			if (err && (err.error_code === 427 || (err.error || '').toString().includes('exists'))) {
				then();
				return;
			}
			Janus.warn('videoroom create error (continuing)', err);
			then();
		}
	});
}

function joinVideoRoom(displayName) {
	state.sfutest.send({
		message: {
			request: 'join',
			room: myroom,
			ptype: 'publisher',
			display: displayName
		}
	});
}

function handlePublisherMessage(msg, jsep) {
	console.debug('[VIDEOROOM] handlePublisherMessage', msg, jsep ? 'has-jsep' : 'no-jsep');
	const event = msg['videoroom'];
	if (event) {
		if (event === 'joined') {
			state.myid = msg['id'];
			state.mypvtid = msg['private_id'];
			console.debug('[VIDEOROOM] joined room, myid=', state.myid, 'mypvtid=', state.mypvtid,
				'existing publishers=', msg['publishers'] ? msg['publishers'].length : 0);
			hideRoomWaitOverlay();
			publishOwnFeed(true);
			if (msg['publishers']) attachToPublishers(msg['publishers']);
		} else if (event === 'destroyed') {
			bootbox.alert('Der Raum wurde gelöscht', function () { window.location.reload(); });
		} else if (event === 'event') {
			if (msg['streams']) {
				const streams = msg['streams'];
				for (const i in streams) {
					streams[i].id = state.myid;
					streams[i].display = state.myusername;
				}
				state.feedStreams[state.myid] = { id: state.myid, display: state.myusername, streams };
			} else if (msg['publishers']) {
				console.debug('[VIDEOROOM] publisher event: new publishers=', JSON.stringify(msg['publishers']));
				attachToPublishers(msg['publishers']);
			} else if (msg['leaving']) {
				console.debug('[VIDEOROOM] publisher event: leaving=', msg['leaving']);
				unsubscribeFrom(msg['leaving']);
			} else if (msg['unpublished']) {
				console.debug('[VIDEOROOM] publisher event: unpublished=', msg['unpublished']);
				if (msg['unpublished'] === 'ok') { state.sfutest.hangup(); return; }
				unsubscribeFrom(msg['unpublished']);
			} else if (msg['error']) {
				if (msg['error_code'] === 426 && !IS_INTERVIEWER) {
					scheduleRoomJoinRetry();
					return;
				}
				if (msg['error_code'] === 426) {
					bootbox.alert('Raum ' + myroomLabel + ' existiert nicht auf diesem Server.');
				} else {
					bootbox.alert(msg['error']);
				}
			}
			if (typeof msg['record'] === 'boolean') {
				state.recording = msg['record'];
				updateRecordingUI();
			}
		}
	}
	if (jsep) state.sfutest.handleRemoteJsep({ jsep });
}

function attachToPublishers(list) {
	console.debug('[VIDEOROOM] attachToPublishers list=', JSON.stringify(list));
	const sources = [];
	for (const f in list) {
		if (list[f]['dummy']) continue;
		const id = list[f]['id'];
		const display = list[f]['display'];
		const streams = list[f]['streams'] || [];
		for (const i in streams) {
			streams[i].id = id;
			streams[i].display = display;
		}
		console.debug('[VIDEOROOM] attachToPublishers feed id=', id, 'display=', display, 'streamCount=', streams.length);
		state.feedStreams[id] = {
			id, display, streams,
			slot: state.feedStreams[id] ? state.feedStreams[id].slot : null,
			remoteVideos: state.feedStreams[id] ? state.feedStreams[id].remoteVideos : 0
		};
		sources.push(streams);
	}
	if (sources.length) {
		subscribeTo(sources);
	} else {
		console.warn('[VIDEOROOM] attachToPublishers: no subscribable sources in list');
	}
}

function buildAudioCapture() {
	if (state.selectedAudioDeviceId) {
		// Use 'ideal' not 'exact': iOS Chrome exposes unstable/unmatchable mic
		// deviceIds, so 'exact' throws OverconstrainedError and the whole offer
		// fails. 'ideal' falls back to the default mic instead of failing hard.
		return { deviceId: { ideal: state.selectedAudioDeviceId } };
	}
	return true;
}

function buildVideoCapture() {
	if (state.selectedVideoDeviceId) {
		return {
			deviceId: { ideal: state.selectedVideoDeviceId },
			width: { ideal: 1280 },
			height: { ideal: 720 }
		};
	}
	return 'hires';
}

export async function republishOwnFeed() {
	console.debug('[VIDEOROOM] republishOwnFeed requested');
	if (!state.sfutest) {
		console.warn('[VIDEOROOM] republishOwnFeed: sfutest not ready');
		return;
	}
	await publishOwnFeed(true, true);
}

export async function applyVirtualBg(mode) {
	if (mode === 'none') {
		stopVirtualBg();
	} else {
		setVirtualBgMode(mode);
	}
	await republishOwnFeed();
}

export function applyOutputDeviceToAll() {
	if (!state.selectedOutputDeviceId) return;
	const audios = document.querySelectorAll('audio');
	audios.forEach((audio) => {
		if (typeof audio.setSinkId === 'function') {
			audio.setSinkId(state.selectedOutputDeviceId).catch(() => {});
		}
	});
}

function findPublishedVideoMid() {
	const myFeed = state.feedStreams[state.myid];
	if (!myFeed || !myFeed.streams) return null;
	for (const s of myFeed.streams) {
		if (s && s.type === 'video') return s.mid;
	}
	return null;
}

async function publishOwnFeed(useAudio, replace) {
	console.debug('[VIDEOROOM] publishOwnFeed starting, useAudio=', useAudio, 'replace=', !!replace);
	const tracks = [];

	// If replacing, stop the old tracks first to release hardware resources
	if (replace) {
		console.debug('[VIDEOROOM] publishOwnFeed: replace=true, stopping old tracks. cameraEnabled=', state.cameraEnabled, 'virtualBgMode=', state.virtualBgMode, 'videoTrackPublished=', state.videoTrackPublished);
		if (state.localTracks.audio && typeof state.localTracks.audio.stop === 'function') {
			try { state.localTracks.audio.stop(); } catch (e) { console.warn('Error stopping audio track:', e); }
		}
		if (state.localTracks.video && typeof state.localTracks.video.stop === 'function') {
			try { console.debug('[VIDEOROOM] publishOwnFeed: stopping old video track', state.activeLocalVideoTrackId); state.localTracks.video.stop(); } catch (e) { console.warn('Error stopping video track:', e); }
		}
		// Tear down the old #myvideo preview track too (canvas track for VBG, or the
		// original preinterview track if we were on a non-VBG initial publish). The
		// next handleLocalTrack must rebuild #myvideo from scratch.
		try {
			const oldMyV = document.getElementById('myvideo');
			const oldPreview = oldMyV && oldMyV.srcObject && oldMyV.srcObject.getVideoTracks()[0];
			if (oldPreview && typeof oldPreview.stop === 'function') oldPreview.stop();
			if (oldMyV) oldMyV.srcObject = null;
		} catch (e) {}
		localPreviewActive = false;
	}

	// Prefer the live stream from the preinterview modal (initial publish only).
	// This avoids a second getUserMedia → second mobile prompt + camera LED flicker.
	const preStream = !replace ? state.preinterviewStream : null;
	const preAudioTrack = preStream ? preStream.getAudioTracks()[0] : null;
	const preVideoTrack = preStream ? preStream.getVideoTracks()[0] : null;

	const audioTrack = { type: 'audio', recv: false };
	if (preAudioTrack && preAudioTrack.readyState === 'live') {
		audioTrack.capture = preAudioTrack;
	} else {
		audioTrack.capture = buildAudioCapture();
	}

	// Firefox refuses to render a track that a PeerConnection sender already holds.
	// Strategy (FIREFOX ONLY): keep the ORIGINAL preinterview video track for the
	// <video> preview element, and hand a CLONE to Janus for the PeerConnection.
	// Same underlying hardware source, two independent track objects — Firefox
	// renders the original because the PC never sees it. Only for the non-VBG path;
	// the VBG path replaces the preview with the canvas output below.
	//
	// On Chrome this pre-attach is SKIPPED: Chrome renders the preview fine through
	// the normal handleLocalTrack path, and feeding Janus a clone breaks Chrome's
	// H264 encoder (it never encodes — interviewer sees nothing). See IS_FIREFOX.
	let previewVideoTrack = null;
	if (IS_FIREFOX && state.cameraEnabled && preVideoTrack && preVideoTrack.readyState === 'live'
		&& (!state.virtualBgMode || state.virtualBgMode === 'none')) {
		previewVideoTrack = preVideoTrack;
		console.debug('[VIDEOROOM] publishOwnFeed: pre-attaching preinterview video to #myvideo (Firefox workaround)');
		$('#videolocal .no-video-container').remove();
		if (!document.getElementById('myvideo')) {
			$('#videolocal').empty();
			$('#videolocal').prepend('<video class="w-full h-full object-cover" id="myvideo" autoplay playsinline muted="muted"></video>');
		}
		const myVideoEl = document.getElementById('myvideo');
		myVideoEl.srcObject = new MediaStream([previewVideoTrack]);
		myVideoEl.play().then(() => {
			console.debug('[VIDEOROOM] pre-attach play() resolved, readyState=', myVideoEl.readyState, 'videoWidth=', myVideoEl.videoWidth);
		}).catch((e) => console.warn('[VIDEOROOM] pre-attach play() rejected', e && e.name));
		localPreviewActive = true;
		state.localVideos = 1;
	}

	let videoCapture = buildVideoCapture();

	if (state.cameraEnabled && state.virtualBgMode && state.virtualBgMode !== 'none') {
		console.debug('[VIDEOROOM] publishOwnFeed: entering virtual-bg branch, mode=', state.virtualBgMode);
		try {
			let rawTrack = null;
			if (preVideoTrack && preVideoTrack.readyState === 'live') {
				console.debug('[VIDEOROOM] publishOwnFeed: using preinterviewStream video track as raw source for VBG');
				rawTrack = preVideoTrack;
			} else {
				const constraints = typeof videoCapture === 'string'
					? { width: { ideal: 1280 }, height: { ideal: 720 } }
					: videoCapture;
				console.debug('[VIDEOROOM] publishOwnFeed: calling getUserMedia for raw camera, constraints=', JSON.stringify(constraints));
				const rawStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
				rawTrack = rawStream.getVideoTracks()[0];
				console.debug('[VIDEOROOM] publishOwnFeed: getUserMedia resolved, rawTrack readyState=', rawTrack && rawTrack.readyState);
			}
			console.debug('[VIDEOROOM] publishOwnFeed: calling startVirtualBg');
			const canvasTrack = await startVirtualBg(rawTrack, state.virtualBgMode);
			console.debug('[VIDEOROOM] publishOwnFeed: startVirtualBg returned canvasTrack=', !!canvasTrack, canvasTrack ? ('readyState=' + canvasTrack.readyState) : '');
			if (canvasTrack) {
				// Original canvas track for preview, clone for the PeerConnection.
				// NOTE: unlike the raw-camera path, cloning a CANVAS captureStream
				// track does NOT break Chrome's H264 encoder (confirmed working on
				// both Chrome and Firefox in production), so this stays unconditional.
				logTrackDetails('canvas original (preview)', canvasTrack);
				videoCapture = canvasTrack.clone();
				logTrackDetails('canvas clone (to Janus)', videoCapture);
				$('#videolocal .no-video-container').remove();
				if (!document.getElementById('myvideo')) {
					$('#videolocal').empty();
					$('#videolocal').prepend('<video class="w-full h-full object-cover" id="myvideo" autoplay playsinline muted="muted"></video>');
				}
				const myVideoElVbg = document.getElementById('myvideo');
				myVideoElVbg.srcObject = new MediaStream([canvasTrack]);
				myVideoElVbg.play().catch((e) => console.warn('[VIDEOROOM] pre-attach (VBG) play() rejected', e && e.name));
				localPreviewActive = true;
				state.localVideos = 1;
			} else {
				console.warn('[VIDEOROOM] publishOwnFeed: startVirtualBg returned no track, stopping raw track');
				if (rawTrack !== preVideoTrack) rawTrack.stop();
			}
		} catch (e) {
			console.warn('[VIDEOROOM] Virtual bg failed, falling back to raw camera', e);
			stopVirtualBg();
		}
	} else if (state.cameraEnabled) {
		if (isVirtualBgActive()) stopVirtualBg();
		if (preVideoTrack && preVideoTrack.readyState === 'live') {
			if (IS_FIREFOX) {
				// Firefox: hand Janus a CLONE, keep original for the preview (above).
				logTrackDetails('original (preview)', preVideoTrack);
				videoCapture = preVideoTrack.clone();
				console.debug('[VIDEOROOM] publishOwnFeed: [firefox] cloned preinterview track for Janus; originalId=', preVideoTrack.id, 'cloneId=', videoCapture.id, 'cloneReadyState=', videoCapture.readyState, 'cloneMuted=', videoCapture.muted);
				logTrackDetails('clone (to Janus)', videoCapture);
			} else {
				// Chrome/other: hand Janus the ORIGINAL track. Cloning breaks Chrome's
				// H264 SimulcastEncoderAdapter (framesEncoded stays 0). The preview is
				// rendered normally by handleLocalTrack from this same track.
				videoCapture = preVideoTrack;
				console.debug('[VIDEOROOM] publishOwnFeed: [chrome] handing ORIGINAL preinterview track to Janus; id=', preVideoTrack.id, 'readyState=', preVideoTrack.readyState);
				logTrackDetails('original (to Janus)', preVideoTrack);
			}
		}
	} else {
		if (isVirtualBgActive()) stopVirtualBg();
	}

	// The preinterview stream's tracks are now owned by the videoCapture handoff
	// (or by the VBG canvas pipeline). Drop our reference so we don't double-release.
	// If camera is disabled, release the unused video track here.
	if (preStream) {
		if (!state.cameraEnabled && preVideoTrack && preVideoTrack.readyState === 'live') {
			preVideoTrack.stop();
		}
		state.preinterviewStream = null;
	}

	if (replace) {
		audioTrack.replace = true;
	} else {
		audioTrack.add = true;
	}
	if (useAudio) tracks.push(audioTrack);

	if (state.cameraEnabled) {
		const videoTrack = { type: 'video', capture: videoCapture, recv: false };
		if (replace && state.videoTrackPublished) videoTrack.replace = true; else videoTrack.add = true;
		console.debug('[VIDEOROOM] publishOwnFeed: video track op=', videoTrack.replace ? 'replace' : 'add',
			'captureKind=', (videoCapture && videoCapture.kind) || typeof videoCapture);
		tracks.push(videoTrack);
	} else if (state.videoTrackPublished) {
		const videoMid = findPublishedVideoMid();
		if (videoMid) {
			tracks.push({ type: 'video', mid: videoMid, remove: true });
		}
		stopLocalVideoTrack();
		if (state.localVideos === 0 && $('#videolocal .no-video-container').length === 0) {
			$('#videolocal').prepend(noVideoPlaceholder('Keine Webcam'));
		}
		state.videoTrackPublished = false;
	}

	console.debug('[VIDEOROOM] publishOwnFeed: calling createOffer with', tracks.length, 'track(s):',
		tracks.map(t => t.type + ':' + (t.replace ? 'replace' : t.add ? 'add' : t.remove ? 'remove' : '?')).join(','));
	state.sfutest.createOffer({
		tracks,
		success: function (jsep) {
			console.debug('[VIDEOROOM] createOffer success, sending configure');
			try {
				state.sfutest.send({ message: { request: 'configure', audio: useAudio, video: state.cameraEnabled }, jsep });
			} catch (e) {
				console.error('[VIDEOROOM] error while sending configure', e);
			}
			// Confirm the outbound video encoder actually starts producing frames.
			// On the failing Firefox sessions the encoder sat at 0x0 / 0 frames the
			// whole call (interviewer saw nothing). Sample at 5s and 12s so the report
			// shows whether the encoder ever got going.
			if (state.cameraEnabled) checkOutboundVideoHealth();
		},
		error: function (error) {
			Janus.error('WebRTC error', error);
			// Error objects serialize to {} via JSON because name/message are
			// non-enumerable; pull them out explicitly so the trace is useful.
			console.error('[VIDEOROOM] createOffer error',
				'name=', error && error.name,
				'message=', error && error.message,
				'constraint=', error && error.constraint,
				'useAudio=', useAudio, 'cameraEnabled=', state.cameraEnabled,
				'selectedAudioDeviceId=', state.selectedAudioDeviceId || '(default)',
				'selectedVideoDeviceId=', state.selectedVideoDeviceId || '(default)');
			if (useAudio) {
				publishOwnFeed(false, replace);
			} else {
				showWebrtcErrorModal(error);
			}
		}
	});
}

function handleLocalTrack(track, on) {
	const trackId = track.id.replace(/[{}]/g, '');
	console.debug('[VIDEOROOM] handleLocalTrack', { id: trackId, kind: track.kind, on });
	if (!on) {
		if (track.kind === 'audio' && state.activeLocalAudioTrackId && state.activeLocalAudioTrackId !== trackId) {
			delete state.localTracks[trackId];
			return;
		}
		if (track.kind === 'video' && state.activeLocalVideoTrackId && state.activeLocalVideoTrackId !== trackId) {
			delete state.localTracks[trackId];
			return;
		}
		if (track.kind === 'video') {
			stopLocalVideoTrack();
			if (state.localVideos === 0 && $('#videolocal .no-video-container').length === 0) {
				$('#videolocal').prepend(noVideoPlaceholder('Keine Webcam'));
			}
		} else if (track.kind === 'audio') {
			delete state.localTracks.audio;
			state.activeLocalAudioTrackId = '';
		}
		delete state.localTracks[trackId];
		return;
	}
	if (track.kind === 'audio' && state.activeLocalAudioTrackId === trackId) return;
	if (track.kind === 'video' && state.activeLocalVideoTrackId === trackId) return;

	$('#videos').removeClass('hide');

	if (track.kind === 'audio') {
		state.localTracks.audio = track;
		state.activeLocalAudioTrackId = trackId;
		if (!localPreviewActive && state.localVideos === 0 && $('#videolocal .no-video-container').length === 0) {
			$('#videolocal').prepend(noVideoPlaceholder('Keine Webcam'));
		}
	} else {
		console.debug('[VIDEOROOM] handleLocalTrack: video track', trackId, 'readyState=', track.readyState, 'muted=', track.muted);
		if (localPreviewActive && document.getElementById('myvideo')) {
			// #myvideo is showing the original preinterview track (or VBG canvas);
			// Janus's track is the clone going to the PC. Don't touch the element —
			// that would tear down the rendering pipeline Firefox just spun up.
			const _dbgEl = document.getElementById('myvideo');
			const _dbgPreviewTrack = _dbgEl && _dbgEl.srcObject && _dbgEl.srcObject.getVideoTracks()[0];
			console.debug('[VIDEOROOM] handleLocalTrack: local preview already active, skipping re-attach;',
				'previewTrackId=', _dbgPreviewTrack ? _dbgPreviewTrack.id : 'none',
				'previewReadyState=', _dbgPreviewTrack ? _dbgPreviewTrack.readyState : 'n/a',
				'previewMuted=', _dbgPreviewTrack ? _dbgPreviewTrack.muted : 'n/a',
				'el.paused=', _dbgEl ? _dbgEl.paused : 'n/a',
				'el.videoWidth=', _dbgEl ? _dbgEl.videoWidth : 'n/a');
			state.localVideos = 1;
			state.activeLocalVideoTrackId = trackId;
			state.videoTrackPublished = true;
			state.localTracks.video = track;
		} else {
			// Tear down any previous video element/track FIRST, then record the new
			// track. Reverse order would cause stopLocalVideoTrack to kill the new
			// track we just received.
			stopLocalVideoTrack();
			state.localVideos = 1;
			state.activeLocalVideoTrackId = trackId;
			state.videoTrackPublished = true;
			state.localTracks.video = track;
			$('#videolocal .no-video-container').remove();
			$('#videolocal').empty();
			$('#videolocal').prepend('<video class="w-full h-full object-cover" id="myvideo" autoplay playsinline muted="muted"></video>');
			const myVideoEl = document.getElementById('myvideo');
			Janus.attachMediaStream(myVideoEl, new MediaStream([track]));
			console.debug('[VIDEOROOM] handleLocalTrack: #myvideo attached, readyState=', myVideoEl.readyState);
			myVideoEl.play().then(() => {
				console.debug('[VIDEOROOM] handleLocalTrack: #myvideo play() resolved, readyState=', myVideoEl.readyState, 'videoWidth=', myVideoEl.videoWidth);
			}).catch((e) => {
				console.warn('[VIDEOROOM] handleLocalTrack: #myvideo play() rejected', e && e.name, e && e.message);
			});
		}
	}
}

function noVideoPlaceholder(label) {
	return '<div class="no-video-container w-full h-full flex flex-col items-center justify-center text-white">' +
		'<i class="fa-solid fa-video-slash text-2xl mb-1 opacity-70"></i>' +
		'<span class="text-xs opacity-80">' + escapeHtml(label) + '</span></div>';
}

function subscribeTo(sources) {
	if (creatingSubscription) {
		console.debug('[VIDEOROOM] subscribeTo deferred (creatingSubscription in progress)');
		setTimeout(() => subscribeTo(sources), 300);
		return;
	}
	if (state.remoteFeed) {
		const added = [], removed = [];
		for (const s in sources) {
			const streams = sources[s];
			for (const i in streams) {
				const stream = streams[i];
				if (stream.disabled) {
					if (state.subscriptions[stream.id]) delete state.subscriptions[stream.id][stream.mid];
					removed.push({ feed: stream.id, mid: stream.mid });
					continue;
				}
				if (state.subscriptions[stream.id] && state.subscriptions[stream.id][stream.mid]) continue;
				assignSlot(stream);
				added.push({ feed: stream.id, mid: stream.mid });
				if (!state.subscriptions[stream.id]) state.subscriptions[stream.id] = {};
				state.subscriptions[stream.id][stream.mid] = true;
			}
		}
		console.debug('[VIDEOROOM] subscribeTo update branch added=', added, 'removed=', removed);
		if (!added.length && !removed.length) return;
		const update = { request: 'update' };
		if (added.length) update.subscribe = added;
		if (removed.length) update.unsubscribe = removed;
		state.remoteFeed.send({ message: update });
		return;
	}

	console.debug('[VIDEOROOM] subscribeTo: creating new subscriber handle, mypvtid=', state.mypvtid);
	creatingSubscription = true;
	state.janus.attach({
		plugin: 'janus.plugin.videoroom',
		opaqueId: state.opaqueId,
		success: function (pluginHandle) {
			state.remoteFeed = pluginHandle;
			state.remoteTracks = {};
			console.debug('[VIDEOROOM] subscriber handle attached, id=', pluginHandle.getId());
			const subscription = [];
			for (const s in sources) {
				const streams = sources[s];
				for (const i in streams) {
					const stream = streams[i];
					if (stream.disabled) continue;
					if (state.subscriptions[stream.id] && state.subscriptions[stream.id][stream.mid]) continue;
					assignSlot(stream);
					subscription.push({ feed: stream.id, mid: stream.mid });
					if (!state.subscriptions[stream.id]) state.subscriptions[stream.id] = {};
					state.subscriptions[stream.id][stream.mid] = true;
				}
			}
			console.debug('[VIDEOROOM] subscriber sending join with streams=', subscription);
			state.remoteFeed.send({
				message: {
					request: 'join',
					room: myroom,
					ptype: 'subscriber',
					streams: subscription,
					private_id: state.mypvtid
				}
			});
		},
		error: function (error) {
			Janus.error('Subscriber attach error', error);
			console.error('[VIDEOROOM] subscriber attach error', error);
			creatingSubscription = false;
		},
		iceState: function (iceState) {
			console.debug('[VIDEOROOM] subscriber iceState ->', iceState);
		},
		webrtcState: function (on, reason) {
			console.debug('[VIDEOROOM] subscriber webrtcState ->', on, reason || '');
		},
		slowLink: function (uplink, lost, mid) {
			console.debug('[VIDEOROOM] subscriber slowLink uplink=', uplink, 'lost=', lost, 'mid=', mid);
		},
		onmessage: handleSubscriberMessage,
		onremotetrack: handleRemoteTrack,
		oncleanup: function () {
			console.warn('[VIDEOROOM] subscriber oncleanup fired');
			snapshotHandleStats('subscriber (videoroom)', state.remoteFeed, 'oncleanup');
			recoverSubscriber('oncleanup');
		}
	});
}

function assignSlot(stream) {
	if (!state.feedStreams[stream.id]) return;
	if (state.feedStreams[stream.id].slot) return;
	state.feedStreams[stream.id].slot = 1;
	state.feedStreams[stream.id].remoteVideos = 0;
	state.feeds[1] = stream.id;
	$('#remote1').removeClass('hide').text(stream.display || '');
}

function handleSubscriberMessage(msg, jsep) {
	const event = msg['videoroom'];
	console.debug('[VIDEOROOM] handleSubscriberMessage event=', event, 'msg=', msg, jsep ? 'has-jsep' : 'no-jsep');
	if (msg['error']) {
		console.error('[VIDEOROOM] Subscriber error', msg['error_code'], msg['error']);
		creatingSubscription = false;
		// 428 "No such feed" / 424 "unconfigured participant": during a
		// simultaneous reconnect the subscriber join landed on a feed that was
		// torn down mid-flight, so this handle never got configured and can never
		// accept an 'update'. Tear it down and re-subscribe cleanly to the
		// publishers we currently know about (e.g. the peer's new feed).
		if (msg['error_code'] === 428 || msg['error_code'] === 424) {
			recoverSubscriber('subscriber-error-' + msg['error_code']);
		}
		return;
	}
	if (event === 'attached') creatingSubscription = false;
	if (msg['streams']) {
		for (const i in msg['streams']) {
			const mid = msg['streams'][i]['mid'];
			state.subStreams[mid] = msg['streams'][i];
			const feed = state.feedStreams[msg['streams'][i]['feed_id']];
			if (feed && feed.slot) {
				state.slots[mid] = feed.slot;
				state.mids[feed.slot] = mid;
			}
		}
	}
	if (jsep) {
		state.remoteFeed.createAnswer({
			jsep,
			tracks: [{ type: 'data' }],
			success: function (jsep) {
				state.remoteFeed.send({ message: { request: 'start', room: myroom }, jsep });
			},
			error: function (error) {
				Janus.error('Subscriber answer error', error);
			}
		});
	}
}

function handleRemoteTrack(track, mid, on) {
	console.debug('[VIDEOROOM] handleRemoteTrack mid=', mid, 'kind=', track && track.kind, 'on=', on);
	const sub = state.subStreams[mid];
	if (!sub) {
		console.warn('[VIDEOROOM] handleRemoteTrack: no subStream for mid=', mid, '- ignoring track');
		return;
	}
	const feed = state.feedStreams[sub.feed_id];
	let slot = state.slots[mid] || (feed && feed.slot) || 1;
	state.slots[mid] = slot;
	if (feed) state.mids[feed.slot] = mid;

	const containerId = '#videoremote' + slot;
	const elementId = 'remotevideo' + slot + '-' + mid;

	if (!on) {
		$('#' + elementId).remove();
		if (track.kind === 'video' && feed) {
			feed.remoteVideos--;
			if (feed.remoteVideos === 0 && $(containerId + ' .no-video-container').length === 0) {
				$(containerId).append(noVideoPlaceholder('Keine Webcam'));
			}
		}
		delete state.remoteTracks[mid];
		return;
	}
	if ($('#' + elementId).length > 0) return;

	if (track.kind === 'audio') {
		const stream = new MediaStream([track]);
		state.remoteTracks[mid] = stream;
		$(containerId).append('<audio class="hide" id="' + elementId + '" autoplay playsinline></audio>');
		Janus.attachMediaStream(document.getElementById(elementId), stream);
		if ($(containerId + ' video').length === 0) {
			$(containerId + ' .no-video-container').remove();
			$(containerId).prepend(noVideoPlaceholder('Keine Webcam'));
		}
		const audioEl = document.getElementById(elementId);
		if (audioEl) {
			if (state.selectedOutputDeviceId && typeof audioEl.setSinkId === 'function') {
				audioEl.setSinkId(state.selectedOutputDeviceId).catch(() => {});
			}
			const playPromise = audioEl.play();
			if (playPromise && typeof playPromise.catch === 'function') {
				playPromise.catch(() => {});
			}
		}
	} else {
		feed.remoteVideos = (feed.remoteVideos || 0) + 1;
		subscriberRecoveryAttempts = 0;
		$(containerId + ' .no-video-container').remove();
		const stream = new MediaStream([track]);
		state.remoteTracks[mid] = stream;
		$(containerId).append('<video class="w-full h-full object-cover" id="' + elementId + '" autoplay playsinline></video>');
		const remoteVideoEl = document.getElementById(elementId);
		Janus.attachMediaStream(remoteVideoEl, stream);
		console.debug('[VIDEOROOM] handleRemoteTrack: video el attached mid=', mid, 'readyState=', remoteVideoEl.readyState, 'paused=', remoteVideoEl.paused);
		remoteVideoEl.play().then(() => {
			console.debug('[VIDEOROOM] handleRemoteTrack: video el play() resolved mid=', mid, 'readyState=', remoteVideoEl.readyState, 'videoWidth=', remoteVideoEl.videoWidth);
			setTimeout(() => {
				const t = remoteVideoEl.srcObject && remoteVideoEl.srcObject.getVideoTracks()[0];
				console.debug('[VIDEOROOM] handleRemoteTrack: 3s check mid=', mid, 'currentTime=', remoteVideoEl.currentTime, 'videoWidth=', remoteVideoEl.videoWidth, 'trackState=', t && t.readyState, 'trackMuted=', t && t.muted);
			}, 3000);
		}).catch((e) => {
			console.warn('[VIDEOROOM] handleRemoteTrack: video el play() rejected mid=', mid, e && e.name, e && e.message);
		});
	}
}

// Reset all subscriber-side state and schedule a fresh subscription to whatever
// publishers we currently know about. Called both when the subscriber PC is torn
// down (oncleanup) and when the subscriber handle ends up unusable after a fatal
// join error (428 "No such feed" / 424 "unconfigured participant") during a
// simultaneous reconnect. The subscriberRecovering flag dedupes the two paths so
// a detach()-triggered oncleanup and an explicit error-branch call don't both
// fire a re-subscribe.
function recoverSubscriber(reason) {
	if (subscriberRecovering) {
		console.debug('[VIDEOROOM] recoverSubscriber: already recovering, skipping (', reason, ')');
		return;
	}
	subscriberRecovering = true;
	console.warn('[VIDEOROOM] recoverSubscriber: resetting subscription state, reason=', reason);

	const stale = state.remoteFeed;
	state.remoteFeed = null;
	state.remoteTracks = {};
	state.subscriptions = {};
	state.subStreams = {};
	state.slots = {};
	state.mids = {};
	creatingSubscription = false;
	for (const id in state.feedStreams) {
		if (id == state.myid) continue;
		if (state.feedStreams[id]) {
			state.feedStreams[id].slot = null;
			state.feedStreams[id].remoteVideos = 0;
		}
	}
	$('#videoremote1').empty().append(noVideoPlaceholder(IS_INTERVIEWER ? 'Warten auf Teilnehmer:in' : 'Warten auf Interviewer'));

	// Detach the dead handle so the server frees it. Its oncleanup will route
	// back here but the subscriberRecovering guard makes that a no-op.
	if (stale) {
		try { stale.detach(); } catch (e) { /* already gone */ }
	}

	if (subscriberRecoveryAttempts < MAX_SUBSCRIBER_RECOVERY) {
		subscriberRecoveryAttempts += 1;
		const delay = 800 * subscriberRecoveryAttempts;
		console.debug('[VIDEOROOM] scheduling subscriber recovery attempt', subscriberRecoveryAttempts, 'in', delay, 'ms');
		setTimeout(() => {
			subscriberRecovering = false;
			resubscribeKnownFeeds();
		}, delay);
	} else {
		subscriberRecovering = false;
		console.warn('[VIDEOROOM] subscriber recovery attempts exhausted');
	}
}

// Rebuild the subscription for all publishers we currently know about. Used to
// recover after the subscriber PeerConnection is torn down (oncleanup), which
// otherwise leaves the rejoining peer permanently unable to see the other side.
function resubscribeKnownFeeds() {
	const sources = [];
	for (const id in state.feedStreams) {
		if (id == state.myid) continue;
		const feed = state.feedStreams[id];
		if (feed && feed.streams && feed.streams.length) sources.push(feed.streams);
	}
	if (!sources.length) {
		console.debug('[VIDEOROOM] resubscribeKnownFeeds: no known remote feeds to recover');
		return;
	}
	console.debug('[VIDEOROOM] resubscribeKnownFeeds: re-subscribing to', sources.length, 'feed(s)');
	subscribeTo(sources);
}

function unsubscribeFrom(id) {
	const feed = state.feedStreams[id];
	if (!feed) return;
	$('#remote' + feed.slot).empty().addClass('hide');
	$('#videoremote' + feed.slot).empty().append(noVideoPlaceholder(IS_INTERVIEWER ? 'Teilnehmer:in getrennt' : 'Interviewer:in getrennt'));
	delete state.feeds[feed.slot];
	delete state.feedStreams[id];
	delete state.subscriptions[id];
	if (state.remoteFeed) state.remoteFeed.send({ message: { request: 'unsubscribe', streams: [{ feed: id }] } });
}
