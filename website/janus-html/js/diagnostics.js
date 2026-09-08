import { state, IS_INTERVIEWER, myroom, myroomLabel } from './state.js';

// Persistent ring buffer of console output, used by the on-demand diagnostic
// panel/report. Capture runs for both roles. NOTE: logs are kept locally only —
// they are never transmitted over the data channel to the other participant.
const MAX_LOGS = 500;
const persistentLogs = []; // every log we've seen, capped at MAX_LOGS
let captureInstalled = false;

// --- WebRTC time-series sampler ---
// Polls getStats() on every live PC at a fixed interval and records a compact
// one-line summary per PC. This is what reveals problems that happen over time
// (first-seconds ICE migration, mid-call freezes, bitrate collapse) that a
// single end-of-session snapshot can't show.
const SAMPLE_INTERVAL_MS = 2000;
const MAX_SAMPLES = 400; // 400 * 2s = ~13 min of history per PC line
const statsSamples = []; // [{ t, rows: [string, ...] }]
let samplerStarted = false;
const sessionStartMs = Date.now();

function elapsed() {
	const s = (Date.now() - sessionStartMs) / 1000;
	return s.toFixed(1) + 's';
}

async function sampleOnce() {
	const handles = [
		{ short: 'pub', handle: state.sfutest },
		{ short: 'sub', handle: state.remoteFeed },
		{ short: 'txt', handle: state.textHandle }
	];
	const rows = [];
	for (const { short, handle } of handles) {
		if (!handle) continue;
		const pc = handle.webrtcStuff && handle.webrtcStuff.pc;
		if (!pc) continue;
		try {
			const stats = await pc.getStats(null);
			let active = null, activeTraffic = -1;
			let outV = null, inV = null, outA = null, inA = null;
			let iceState = pc.iceConnectionState;
			stats.forEach((s) => {
				if (s.type === 'candidate-pair') {
					const traf = (s.bytesSent || 0) + (s.bytesReceived || 0);
					if (traf > activeTraffic) { activeTraffic = traf; active = s; }
				} else if (s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'video') outV = s;
				else if (s.type === 'inbound-rtp'  && (s.kind || s.mediaType) === 'video') inV = s;
				else if (s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'audio') outA = s;
				else if (s.type === 'inbound-rtp'  && (s.kind || s.mediaType) === 'audio') inA = s;
			});
			const parts = [short, iceState];
			if (active) {
				parts.push(active.state + (active.nominated ? '*' : ''));
				parts.push('rtt=' + fmt(active.currentRoundTripTime));
				parts.push('out=' + (active.bytesSent || 0));
				parts.push('in=' + (active.bytesReceived || 0));
				if (active.availableOutgoingBitrate != null) parts.push('outBps=' + Math.round(active.availableOutgoingBitrate));
			} else {
				parts.push('no-active-pair');
			}
			if (outV) parts.push('outV=' + outV.frameWidth + 'x' + outV.frameHeight + '@' + fmt(outV.framesPerSecond) + (outV.qualityLimitationReason && outV.qualityLimitationReason !== 'none' ? ',lim=' + outV.qualityLimitationReason : ''));
			if (inV)  parts.push('inV='  + inV.frameWidth + 'x' + inV.frameHeight + '@' + fmt(inV.framesPerSecond) + ',frz=' + (inV.freezeCount || 0) + (inV.packetsLost ? ',lost=' + inV.packetsLost : ''));
			if (outA) parts.push('outA=lvl' + fmt(outA.audioLevel != null ? outA.audioLevel : (outA.targetBitrate || '')));
			if (inA)  parts.push('inA=lvl' + fmt(inA.audioLevel) + (inA.concealedSamples ? ',concealed=' + inA.concealedSamples : '') + (inA.packetsLost ? ',lost=' + inA.packetsLost : ''));
			rows.push(parts.join(' '));
		} catch (e) {
			rows.push(short + ' stats-error: ' + ((e && e.message) || e));
		}
	}
	if (rows.length) {
		statsSamples.push({ t: elapsed(), rows });
		if (statsSamples.length > MAX_SAMPLES) statsSamples.shift();
	}
}

function startSampler() {
	if (samplerStarted) return;
	samplerStarted = true;
	setInterval(() => { sampleOnce().catch(() => {}); }, SAMPLE_INTERVAL_MS);
}

function captureLog(level, args) {
	const msg = args.map((arg) => {
		if (arg instanceof Error) return arg.stack || (arg.name + ': ' + arg.message);
		if (typeof arg === 'object') {
			try { return JSON.stringify(arg); } catch (e) { return String(arg); }
		}
		return String(arg);
	}).join(' ');
	const entry = { level, msg, time: new Date().toLocaleTimeString() };
	persistentLogs.push(entry);
	if (persistentLogs.length > MAX_LOGS) persistentLogs.shift();
}

function installCapture() {
	if (captureInstalled) return;
	captureInstalled = true;
	const original = {
		log: console.log, warn: console.warn, error: console.error,
		debug: console.debug, info: console.info
	};
	console.log   = (...a) => { captureLog('log',   a); original.log.apply(console, a); };
	console.warn  = (...a) => { captureLog('warn',  a); original.warn.apply(console, a); };
	console.error = (...a) => { captureLog('error', a); original.error.apply(console, a); };
	console.debug = (...a) => { captureLog('debug', a); original.debug.apply(console, a); };
	console.info  = (...a) => { captureLog('info',  a); original.info.apply(console, a); };

	window.addEventListener('error', (e) => {
		captureLog('error', ['[window.onerror]', e.message, 'at', (e.filename || '?') + ':' + (e.lineno || '?')]);
	});
	window.addEventListener('unhandledrejection', (e) => {
		const reason = e.reason && (e.reason.stack || e.reason.message || String(e.reason));
		captureLog('error', ['[unhandledrejection]', reason]);
	});
}

export function initDiagnostics() {
	installCapture();
	startSampler();
}

// Snapshots of PCs that have been torn down (textroom retries, oncleanup,
// republish, etc.). Captured at detach-time so the report can show what failed
// before the live PC took over. Capped to avoid unbounded growth.
const MAX_PC_SNAPSHOTS = 20;
const pcSnapshots = [];

export async function snapshotHandleStats(name, handle, reason) {
	if (!handle) return;
	const pc = handle.webrtcStuff && handle.webrtcStuff.pc;
	if (!pc) return;
	try {
		const summary = await summarizePc(name + ' [detached: ' + (reason || 'unknown') + ']', handle, pc);
		summary.detachedAt = new Date().toLocaleTimeString();
		pcSnapshots.push(summary);
		if (pcSnapshots.length > MAX_PC_SNAPSHOTS) pcSnapshots.shift();
	} catch (e) {
		console.debug('[DIAG] snapshotHandleStats failed', e && e.message);
	}
}

// Pull RTCStats from each known PeerConnection. Janus exposes the underlying
// PC via pluginHandle.webrtcStuff.pc, which is what about:webrtc reads under
// the hood — same data source.
function describeCandidate(c) {
	if (!c) return '?';
	const ipv = (c.address || c.ip || '').includes(':') ? 'IPv6' : 'IPv4';
	return c.candidateType + ' ' + (c.protocol || '') + ' ' + ipv
		+ ' ' + (c.address || c.ip || '?') + ':' + (c.port || '?')
		+ (c.relayProtocol ? '/' + c.relayProtocol : '')
		+ (c.candidateType === 'relay' && c.url ? ' via ' + c.url : '')
		+ (typeof c.priority === 'number' ? ' prio=' + c.priority : '');
}

// Resolve a codec stat id to a readable "mimeType (payloadType) @clock" label.
function codecLabel(byId, codecId) {
	if (!codecId) return '?';
	const c = byId.get(codecId);
	if (!c) return codecId;
	return (c.mimeType || '?')
		+ (c.payloadType != null ? ' pt=' + c.payloadType : '')
		+ (c.clockRate ? ' @' + c.clockRate : '')
		+ (c.channels ? ' ch=' + c.channels : '')
		+ (c.sdpFmtpLine ? ' [' + c.sdpFmtpLine + ']' : '');
}

async function summarizePc(name, handle, pc) {
	const summary = {
		name,
		handleId: handle && typeof handle.getId === 'function' ? handle.getId() : null,
		iceConnectionState: pc.iceConnectionState,
		iceGatheringState: pc.iceGatheringState,
		connectionState: pc.connectionState,
		signalingState: pc.signalingState,
		selectedCandidatePair: null, // the one the browser flagged
		activeCandidatePair: null,   // the one actually carrying traffic
		candidatePairs: [],
		localCandidates: [],
		remoteCandidates: [],
		transports: [],
		inbound: [],
		outbound: [],
		remoteInbound: [],
		remoteOutbound: [],
		dataChannels: [],
		mediaSources: [],
		anomalies: []
	};
	try {
		const stats = await pc.getStats(null);
		const byId = new Map();
		stats.forEach((s) => byId.set(s.id, s));
		stats.forEach((s) => {
			if (s.type === 'candidate-pair') {
				const local = byId.get(s.localCandidateId);
				const remote = byId.get(s.remoteCandidateId);
				const pair = {
					state: s.state,
					nominated: s.nominated,
					selected: s.selected,
					writable: s.writable,
					readable: s.readable,
					responsesReceived: s.responsesReceived,
					responsesSent: s.responsesSent,
					requestsSent: s.requestsSent,
					requestsReceived: s.requestsReceived,
					consentRequestsSent: s.consentRequestsSent,
					bytesSent: s.bytesSent,
					bytesReceived: s.bytesReceived,
					packetsSent: s.packetsSent,
					packetsReceived: s.packetsReceived,
					currentRoundTripTime: s.currentRoundTripTime,
					totalRoundTripTime: s.totalRoundTripTime,
					availableOutgoingBitrate: s.availableOutgoingBitrate,
					availableIncomingBitrate: s.availableIncomingBitrate,
					lastPacketSentTimestamp: s.lastPacketSentTimestamp,
					lastPacketReceivedTimestamp: s.lastPacketReceivedTimestamp,
					priority: s.priority,
					localRaw: local,
					remoteRaw: remote,
					local: describeCandidate(local),
					remote: describeCandidate(remote),
					_traffic: (s.bytesSent || 0) + (s.bytesReceived || 0)
				};
				summary.candidatePairs.push(pair);
				if (s.nominated || s.selected) summary.selectedCandidatePair = pair;
			} else if (s.type === 'local-candidate') {
				summary.localCandidates.push({
					type: s.candidateType,
					protocol: s.protocol,
					relayProtocol: s.relayProtocol,
					address: s.address || s.ip,
					port: s.port,
					url: s.url,
					networkType: s.networkType,
					priority: s.priority,
					isIPv6: (s.address || s.ip || '').includes(':')
				});
			} else if (s.type === 'remote-candidate') {
				summary.remoteCandidates.push({
					type: s.candidateType,
					protocol: s.protocol,
					address: s.address || s.ip,
					port: s.port,
					priority: s.priority,
					isIPv6: (s.address || s.ip || '').includes(':')
				});
			} else if (s.type === 'transport') {
				summary.transports.push({
					dtlsState: s.dtlsState,
					iceState: s.iceState,
					iceRole: s.iceRole,
					iceLocalUsernameFragment: s.iceLocalUsernameFragment,
					selectedCandidatePairChanges: s.selectedCandidatePairChanges,
					bytesSent: s.bytesSent,
					bytesReceived: s.bytesReceived,
					packetsSent: s.packetsSent,
					packetsReceived: s.packetsReceived,
					dtlsCipher: s.dtlsCipher,
					srtpCipher: s.srtpCipher,
					tlsVersion: s.tlsVersion,
					dtlsRole: s.dtlsRole
				});
			} else if (s.type === 'inbound-rtp') {
				summary.inbound.push({
					kind: s.kind || s.mediaType,
					ssrc: s.ssrc,
					codec: codecLabel(byId, s.codecId),
					bytesReceived: s.bytesReceived,
					headerBytesReceived: s.headerBytesReceived,
					packetsReceived: s.packetsReceived,
					packetsLost: s.packetsLost,
					packetsDiscarded: s.packetsDiscarded,
					jitter: s.jitter,
					jitterBufferDelay: s.jitterBufferDelay,
					jitterBufferEmittedCount: s.jitterBufferEmittedCount,
					framesDecoded: s.framesDecoded,
					framesDropped: s.framesDropped,
					framesReceived: s.framesReceived,
					keyFramesDecoded: s.keyFramesDecoded,
					frameWidth: s.frameWidth,
					frameHeight: s.frameHeight,
					framesPerSecond: s.framesPerSecond,
					nackCount: s.nackCount,
					pliCount: s.pliCount,
					firCount: s.firCount,
					freezeCount: s.freezeCount,
					totalFreezesDuration: s.totalFreezesDuration,
					pauseCount: s.pauseCount,
					totalPausesDuration: s.totalPausesDuration,
					totalDecodeTime: s.totalDecodeTime,
					totalInterFrameDelay: s.totalInterFrameDelay,
					// audio quality
					audioLevel: s.audioLevel,
					totalAudioEnergy: s.totalAudioEnergy,
					concealedSamples: s.concealedSamples,
					silentConcealedSamples: s.silentConcealedSamples,
					insertedSamplesForDeceleration: s.insertedSamplesForDeceleration,
					removedSamplesForAcceleration: s.removedSamplesForAcceleration,
					totalSamplesReceived: s.totalSamplesReceived,
					estimatedPlayoutTimestamp: s.estimatedPlayoutTimestamp,
					decoderImplementation: s.decoderImplementation,
					powerEfficientDecoder: s.powerEfficientDecoder
				});
			} else if (s.type === 'outbound-rtp') {
				summary.outbound.push({
					kind: s.kind || s.mediaType,
					ssrc: s.ssrc,
					rid: s.rid,
					codec: codecLabel(byId, s.codecId),
					active: s.active,
					bytesSent: s.bytesSent,
					headerBytesSent: s.headerBytesSent,
					packetsSent: s.packetsSent,
					retransmittedPacketsSent: s.retransmittedPacketsSent,
					retransmittedBytesSent: s.retransmittedBytesSent,
					nackCount: s.nackCount,
					pliCount: s.pliCount,
					firCount: s.firCount,
					frameWidth: s.frameWidth,
					frameHeight: s.frameHeight,
					framesPerSecond: s.framesPerSecond,
					framesSent: s.framesSent,
					framesEncoded: s.framesEncoded,
					keyFramesEncoded: s.keyFramesEncoded,
					qualityLimitationReason: s.qualityLimitationReason,
					qualityLimitationDurations: s.qualityLimitationDurations,
					qualityLimitationResolutionChanges: s.qualityLimitationResolutionChanges,
					totalEncodeTime: s.totalEncodeTime,
					totalPacketSendDelay: s.totalPacketSendDelay,
					targetBitrate: s.targetBitrate,
					encoderImplementation: s.encoderImplementation,
					powerEfficientEncoder: s.powerEfficientEncoder,
					scalabilityMode: s.scalabilityMode
				});
			} else if (s.type === 'remote-inbound-rtp') {
				summary.remoteInbound.push({
					kind: s.kind || s.mediaType,
					ssrc: s.ssrc,
					packetsLost: s.packetsLost,
					jitter: s.jitter,
					roundTripTime: s.roundTripTime,
					totalRoundTripTime: s.totalRoundTripTime,
					roundTripTimeMeasurements: s.roundTripTimeMeasurements,
					fractionLost: s.fractionLost
				});
			} else if (s.type === 'remote-outbound-rtp') {
				summary.remoteOutbound.push({
					kind: s.kind || s.mediaType,
					ssrc: s.ssrc,
					packetsSent: s.packetsSent,
					bytesSent: s.bytesSent,
					remoteTimestamp: s.remoteTimestamp
				});
			} else if (s.type === 'data-channel') {
				summary.dataChannels.push({
					label: s.label,
					protocol: s.protocol,
					dataChannelIdentifier: s.dataChannelIdentifier,
					state: s.state,
					messagesSent: s.messagesSent,
					messagesReceived: s.messagesReceived,
					bytesSent: s.bytesSent,
					bytesReceived: s.bytesReceived
				});
			} else if (s.type === 'media-source') {
				summary.mediaSources.push({
					kind: s.kind,
					trackIdentifier: s.trackIdentifier,
					width: s.width,
					height: s.height,
					frames: s.frames,
					framesPerSecond: s.framesPerSecond,
					audioLevel: s.audioLevel,
					totalAudioEnergy: s.totalAudioEnergy,
					echoReturnLoss: s.echoReturnLoss
				});
			}
		});

		// Determine the pair actually carrying traffic — the highest-traffic
		// succeeded/in-progress pair. The browser's "selected" flag often points
		// at a freshly-nominated pair with 0 bytes while a peer-reflexive pair does
		// the real work (common on Firefox + ICE migration).
		const traffickers = summary.candidatePairs
			.filter((p) => p._traffic > 0)
			.sort((a, b) => b._traffic - a._traffic);
		summary.activeCandidatePair = traffickers[0] || null;

		// --- Anomaly detection ---
		const sel = summary.selectedCandidatePair;
		const act = summary.activeCandidatePair;
		if (sel && act && sel !== act) {
			summary.anomalies.push('SELECTED pair carries no traffic (bytes=' + (sel.bytesSent + sel.bytesReceived)
				+ ') but ACTIVE pair carries ' + act._traffic + ' bytes — ICE migration / mislabeled selection');
		}
		if (sel && sel.state && sel.state !== 'succeeded' && act) {
			summary.anomalies.push('SELECTED pair state=' + sel.state + ' yet media is flowing on a different pair');
		}
		const t = summary.transports[0];
		if (t && t.selectedCandidatePairChanges > 1) {
			summary.anomalies.push('ICE pair changed ' + t.selectedCandidatePairChanges + ' times — path was unstable');
		}
		// IPv6 local candidates with only IPv4 remote candidates = guaranteed dead pairs
		const hasIPv6Local = summary.localCandidates.some((c) => c.isIPv6);
		const hasIPv6Remote = summary.remoteCandidates.some((c) => c.isIPv6);
		if (hasIPv6Local && !hasIPv6Remote) {
			summary.anomalies.push('Gathered IPv6 local candidates but remote is IPv4-only — those pairs can never connect (wasted ICE time)');
		}
		// All host pairs failed → relay-only path
		const hostPairs = summary.candidatePairs.filter((p) => p.localRaw && p.localRaw.candidateType === 'host');
		if (hostPairs.length && hostPairs.every((p) => p.state === 'failed')) {
			summary.anomalies.push('All host-to-host candidate pairs failed — direct P2P blocked, forced through TURN relay');
		}
		// Outbound video stalled
		for (const o of summary.outbound) {
			if (o.kind === 'video' && o.qualityLimitationReason && o.qualityLimitationReason !== 'none') {
				summary.anomalies.push('Outbound video quality limited by: ' + o.qualityLimitationReason
					+ (o.qualityLimitationResolutionChanges ? ' (' + o.qualityLimitationResolutionChanges + ' resolution changes)' : ''));
			}
		}
		// Inbound video freezes
		for (const i of summary.inbound) {
			if (i.kind === 'video' && i.freezeCount > 0) {
				summary.anomalies.push('Inbound video had ' + i.freezeCount + ' freeze(s), total '
					+ (i.totalFreezesDuration != null ? i.totalFreezesDuration.toFixed(1) + 's' : '?'));
			}
		}
	} catch (e) {
		summary.statsError = (e && e.message) || String(e);
	}
	return summary;
}

async function collectPeerConnectionStats() {
	const handles = [
		{ name: 'publisher (videoroom)',   handle: state.sfutest },
		{ name: 'subscriber (videoroom)',  handle: state.remoteFeed },
		{ name: 'textroom (data channel)', handle: state.textHandle }
	];
	const out = [];
	for (const { name, handle } of handles) {
		if (!handle) continue;
		const pc = handle.webrtcStuff && handle.webrtcStuff.pc;
		if (!pc) { out.push({ name, missing: 'no underlying PC' }); continue; }
		out.push(await summarizePc(name, handle, pc));
	}
	// Append historical (detached) PCs so the report shows what failed before
	// the current handle took over.
	for (const snap of pcSnapshots) out.push(snap);
	return out;
}

export async function buildDiagnosticReport() {
	const env = {
		ts: new Date().toISOString(),
		url: window.location.href,
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		language: navigator.language,
		screen: window.screen ? (window.screen.width + 'x' + window.screen.height) : null,
		viewport: window.innerWidth + 'x' + window.innerHeight,
		online: navigator.onLine,
		deviceMemoryGB: navigator.deviceMemory,
		hardwareConcurrency: navigator.hardwareConcurrency,
		connectionType: (navigator.connection && navigator.connection.effectiveType) || null,
		downlinkMbps: (navigator.connection && navigator.connection.downlink) || null
	};
	const sessionInfo = {
		role: IS_INTERVIEWER ? 'interviewer' : 'interviewee',
		roomLabel: myroomLabel,
		roomId: myroom,
		myDisplayId: state.myDisplayId,
		chatReady: state.chatReady,
		cameraEnabled: state.cameraEnabled,
		virtualBgMode: state.virtualBgMode,
		videoTrackPublished: state.videoTrackPublished,
		localVideos: state.localVideos,
		selectedAudioDeviceId: state.selectedAudioDeviceId || '(default)',
		selectedVideoDeviceId: state.selectedVideoDeviceId || '(default)',
		selectedOutputDeviceId: state.selectedOutputDeviceId || '(default)',
		opaqueId: state.opaqueId
	};
	let webrtc = [];
	try { webrtc = await collectPeerConnectionStats(); }
	catch (e) { webrtc = [{ error: (e && e.message) || String(e) }]; }

	const lines = [];
	lines.push('===== FACES diagnostic report =====');
	lines.push('');
	lines.push('--- Environment ---');
	for (const k of Object.keys(env)) lines.push(k + ': ' + env[k]);
	lines.push('');
	lines.push('--- Session ---');
	for (const k of Object.keys(sessionInfo)) lines.push(k + ': ' + sessionInfo[k]);
	lines.push('');
	lines.push('--- WebRTC PeerConnections ---');
	if (!webrtc.length) {
		lines.push('(no active or historical peer connections)');
	} else {
		for (const pc of webrtc) {
			lines.push('');
			lines.push('[' + pc.name + ']' + (pc.detachedAt ? ' (snapshot taken ' + pc.detachedAt + ')' : ''));
			if (pc.missing) { lines.push('  ' + pc.missing); continue; }
			if (pc.statsError) lines.push('  statsError: ' + pc.statsError);
			lines.push('  handleId: ' + pc.handleId);
			lines.push('  ice: ' + pc.iceConnectionState + ' / gathering ' + pc.iceGatheringState + ' / signaling ' + pc.signalingState + ' / connection ' + pc.connectionState);

			// Anomalies first — the whole point of the report
			if (pc.anomalies && pc.anomalies.length) {
				lines.push('  ** ANOMALIES **');
				for (const a of pc.anomalies) lines.push('    !! ' + a);
			}

			if (pc.transports.length) {
				for (const t of pc.transports) {
					lines.push('  transport: dtls=' + t.dtlsState + '(role ' + t.dtlsRole + ') ice=' + t.iceState + ' iceRole=' + t.iceRole
						+ ' bytesOut=' + t.bytesSent + ' bytesIn=' + t.bytesReceived
						+ ' pktsOut=' + t.packetsSent + ' pktsIn=' + t.packetsReceived
						+ ' pairChanges=' + t.selectedCandidatePairChanges
						+ (t.dtlsCipher ? ' dtls=' + t.dtlsCipher : '')
						+ (t.srtpCipher ? ' srtp=' + t.srtpCipher : '')
						+ (t.tlsVersion ? ' tls=' + t.tlsVersion : ''));
				}
			}

			// ACTIVE pair = the one carrying real traffic. This is the truth.
			if (pc.activeCandidatePair) {
				const p = pc.activeCandidatePair;
				lines.push('  ACTIVE pair (carrying traffic): ' + p.local + '  -->  ' + p.remote);
				lines.push('    state=' + p.state + ' rtt=' + p.currentRoundTripTime + 's writable=' + p.writable + ' readable=' + p.readable
					+ ' bytesOut=' + p.bytesSent + ' bytesIn=' + p.bytesReceived
					+ ' pktsOut=' + p.packetsSent + ' pktsIn=' + p.packetsReceived
					+ ' resp=' + p.responsesReceived);
				if (p.availableOutgoingBitrate != null) lines.push('    availableOutgoingBitrate=' + Math.round(p.availableOutgoingBitrate) + ' bps');
				if (p.availableIncomingBitrate != null) lines.push('    availableIncomingBitrate=' + Math.round(p.availableIncomingBitrate) + ' bps');
			}
			// SELECTED pair as flagged by the browser — show only if different from active
			if (pc.selectedCandidatePair && pc.selectedCandidatePair !== pc.activeCandidatePair) {
				const p = pc.selectedCandidatePair;
				lines.push('  SELECTED pair (browser-flagged, may be wrong): ' + p.local + '  -->  ' + p.remote);
				lines.push('    state=' + p.state + ' rtt=' + p.currentRoundTripTime + 's writable=' + p.writable
					+ ' bytesOut=' + p.bytesSent + ' bytesIn=' + p.bytesReceived);
			}

			if (pc.candidatePairs.length) {
				const shown = new Set([pc.activeCandidatePair, pc.selectedCandidatePair]);
				const other = pc.candidatePairs.filter((p) => !shown.has(p));
				if (other.length) {
					lines.push('  all other candidate pairs (' + other.length + '):');
					const order = { 'succeeded': 0, 'in-progress': 1, 'inprogress': 1, 'waiting': 2, 'frozen': 3, 'failed': 4, 'cancelled': 5 };
					other.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
					for (const p of other) {
						lines.push('    [' + p.state + '] ' + p.local + ' --> ' + p.remote
							+ ' (resp=' + (p.responsesReceived || 0) + ' req=' + (p.requestsSent || 0)
							+ ' bytesOut=' + (p.bytesSent || 0) + ' bytesIn=' + (p.bytesReceived || 0) + ')');
					}
				}
			}
			if (pc.localCandidates && pc.localCandidates.length) {
				lines.push('  local candidates gathered (' + pc.localCandidates.length + '):');
				for (const c of pc.localCandidates) {
					lines.push('    ' + c.type + ' ' + (c.protocol || '?') + (c.relayProtocol ? '/' + c.relayProtocol : '')
						+ ' ' + (c.isIPv6 ? 'IPv6' : 'IPv4')
						+ ' ' + (c.address || '?') + ':' + (c.port || '?')
						+ (c.networkType ? ' (' + c.networkType + ')' : '')
						+ (c.url ? ' via ' + c.url : ''));
				}
			}
			if (pc.remoteCandidates && pc.remoteCandidates.length) {
				lines.push('  remote candidates received (' + pc.remoteCandidates.length + '):');
				for (const c of pc.remoteCandidates) {
					lines.push('    ' + c.type + ' ' + (c.protocol || '?') + ' ' + (c.isIPv6 ? 'IPv6' : 'IPv4') + ' ' + (c.address || '?') + ':' + (c.port || '?'));
				}
			}
			for (const r of pc.mediaSources) {
				lines.push('  media-source ' + r.kind + ': '
					+ (r.kind === 'video' ? (r.width + 'x' + r.height + '@' + r.framesPerSecond + ' frames=' + r.frames)
						: ('audioLevel=' + fmt(r.audioLevel) + ' energy=' + fmt(r.totalAudioEnergy) + (r.echoReturnLoss != null ? ' echoReturnLoss=' + fmt(r.echoReturnLoss) : ''))));
			}
			for (const r of pc.inbound) {
				if (r.kind === 'video') {
					lines.push('  inbound  video ssrc=' + r.ssrc + ' codec=' + r.codec);
					lines.push('    bytes=' + r.bytesReceived + ' pkts=' + r.packetsReceived + ' lost=' + r.packetsLost + ' discarded=' + r.packetsDiscarded + ' jitter=' + fmt(r.jitter));
					lines.push('    ' + r.frameWidth + 'x' + r.frameHeight + '@' + r.framesPerSecond + ' decoded=' + r.framesDecoded + ' dropped=' + r.framesDropped + ' received=' + r.framesReceived + ' keyframes=' + r.keyFramesDecoded);
					lines.push('    freezes=' + r.freezeCount + ' totalFreezeDur=' + fmt(r.totalFreezesDuration) + ' pauses=' + r.pauseCount + ' nack=' + r.nackCount + ' pli=' + r.pliCount + ' fir=' + r.firCount);
					lines.push('    decodeTime=' + fmt(r.totalDecodeTime) + ' interFrameDelay=' + fmt(r.totalInterFrameDelay) + ' jitterBufDelay=' + fmt(r.jitterBufferDelay) + ' decoder=' + r.decoderImplementation + ' powerEff=' + r.powerEfficientDecoder);
				} else {
					lines.push('  inbound  audio ssrc=' + r.ssrc + ' codec=' + r.codec);
					lines.push('    bytes=' + r.bytesReceived + ' pkts=' + r.packetsReceived + ' lost=' + r.packetsLost + ' discarded=' + r.packetsDiscarded + ' jitter=' + fmt(r.jitter));
					lines.push('    audioLevel=' + fmt(r.audioLevel) + ' energy=' + fmt(r.totalAudioEnergy) + ' concealed=' + r.concealedSamples + ' silentConcealed=' + r.silentConcealedSamples);
					lines.push('    accel(removed)=' + r.removedSamplesForAcceleration + ' decel(inserted)=' + r.insertedSamplesForDeceleration + ' jitterBufDelay=' + fmt(r.jitterBufferDelay) + ' samplesRecv=' + r.totalSamplesReceived);
				}
			}
			for (const r of pc.outbound) {
				if (r.kind === 'video') {
					lines.push('  outbound video ssrc=' + r.ssrc + (r.rid ? ' rid=' + r.rid : '') + ' codec=' + r.codec + ' active=' + r.active);
					lines.push('    bytes=' + r.bytesSent + ' pkts=' + r.packetsSent + ' retxPkts=' + r.retransmittedPacketsSent + ' retxBytes=' + r.retransmittedBytesSent + ' nack=' + r.nackCount + ' pli=' + r.pliCount + ' fir=' + r.firCount);
					lines.push('    ' + r.frameWidth + 'x' + r.frameHeight + '@' + r.framesPerSecond + ' sent=' + r.framesSent + ' encoded=' + r.framesEncoded + ' keyframes=' + r.keyFramesEncoded);
					lines.push('    limited-by=' + r.qualityLimitationReason + ' resChanges=' + r.qualityLimitationResolutionChanges + ' targetBitrate=' + fmt(r.targetBitrate) + ' encodeTime=' + fmt(r.totalEncodeTime) + ' encoder=' + r.encoderImplementation + ' powerEff=' + r.powerEfficientEncoder + (r.scalabilityMode ? ' svc=' + r.scalabilityMode : ''));
					if (r.qualityLimitationDurations) {
						lines.push('    qualityLimitationDurations: ' + Object.entries(r.qualityLimitationDurations).map(([k, v]) => k + '=' + fmt(v)).join(' '));
					}
				} else {
					lines.push('  outbound audio ssrc=' + r.ssrc + ' codec=' + r.codec + ' active=' + r.active);
					lines.push('    bytes=' + r.bytesSent + ' pkts=' + r.packetsSent + ' retxPkts=' + r.retransmittedPacketsSent + ' nack=' + r.nackCount + ' targetBitrate=' + fmt(r.targetBitrate));
				}
			}
			for (const r of pc.remoteInbound) {
				lines.push('  remote-inbound ' + r.kind + ' ssrc=' + r.ssrc + ': pktsLost=' + r.packetsLost + ' jitter=' + fmt(r.jitter) + ' rtt=' + fmt(r.roundTripTime) + ' fractionLost=' + fmt(r.fractionLost) + ' rttMeasurements=' + r.roundTripTimeMeasurements);
			}
			for (const r of pc.remoteOutbound) {
				lines.push('  remote-outbound ' + r.kind + ' ssrc=' + r.ssrc + ': pktsSent=' + r.packetsSent + ' bytesSent=' + r.bytesSent);
			}
			for (const d of pc.dataChannels) {
				lines.push('  dataChannel "' + d.label + '" id=' + d.dataChannelIdentifier + ' ' + d.state + ' msgsOut=' + d.messagesSent + ' msgsIn=' + d.messagesReceived + ' bytesOut=' + d.bytesSent + ' bytesIn=' + d.bytesReceived);
			}
		}
	}

	// Time-series samples captured by the background sampler
	if (statsSamples.length) {
		lines.push('');
		lines.push('--- WebRTC time-series (' + statsSamples.length + ' samples, ~' + (SAMPLE_INTERVAL_MS / 1000) + 's apart) ---');
		lines.push('Columns: t | pc | iceState | activePair(state) | rtt | bytesOut | bytesIn | outVideo(WxH@fps,limit) | inVideo(WxH@fps,freezes)');
		for (const sample of statsSamples) {
			for (const row of sample.rows) {
				lines.push('  ' + sample.t + ' | ' + row);
			}
		}
	}

	lines.push('');
	lines.push('--- Console log (' + persistentLogs.length + ' entries) ---');
	for (const l of persistentLogs) {
		lines.push('[' + l.time + '] ' + l.level.toUpperCase() + ': ' + l.msg);
	}
	return lines.join('\n');
}

// Compact number formatter — trims long floats, passes through undefined/null.
function fmt(v) {
	if (v == null) return String(v);
	if (typeof v === 'number') {
		if (Number.isInteger(v)) return String(v);
		return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	}
	return String(v);
}

let diagModal = null;

export function setupDiagnosticButton() {
	const btn = document.getElementById('diagnostic-btn');
	if (!btn) return;
	btn.addEventListener('click', openDiagnosticModal);
}

async function openDiagnosticModal() {
	if (diagModal) return;
	diagModal = document.createElement('div');
	diagModal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
	diagModal.innerHTML = `
		<div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-gray-200">
			<div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
				<div class="flex items-center gap-3">
					<i class="fas fa-stethoscope text-blue-600"></i>
					<h2 class="text-lg font-semibold text-gray-900">Diagnose-Bericht</h2>
				</div>
				<button class="diag-close text-gray-500 hover:text-gray-900 text-xl px-2"><i class="fas fa-times"></i></button>
			</div>
			<div class="px-6 py-3 border-b border-gray-200 text-sm text-gray-600">
				Bitte kopieren Sie diesen Bericht und senden Sie ihn an Ihren Ansprechpartner.
			</div>
			<div class="flex-1 overflow-hidden p-4">
				<textarea id="diag-textarea" readonly
					class="w-full h-full p-3 font-mono text-xs border border-gray-300 rounded-lg bg-gray-50 resize-none focus:outline-none"
					style="min-height: 50vh;"></textarea>
			</div>
			<div class="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
				<span id="diag-status" class="text-xs text-gray-500">Bericht wird erstellt…</span>
				<div class="flex gap-2">
					<button class="diag-refresh px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium">
						<i class="fas fa-rotate-right mr-1"></i>Aktualisieren
					</button>
					<button class="diag-download px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium">
						<i class="fas fa-download mr-1"></i>Speichern
					</button>
					<button class="diag-copy px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
						<i class="fas fa-copy mr-1"></i>Kopieren
					</button>
				</div>
			</div>
		</div>
	`;
	document.body.appendChild(diagModal);
	const close = () => { if (diagModal) { diagModal.remove(); diagModal = null; } };
	diagModal.addEventListener('click', (e) => { if (e.target === diagModal) close(); });
	diagModal.querySelector('.diag-close').addEventListener('click', close);
	diagModal.querySelector('.diag-refresh').addEventListener('click', () => refresh());
	diagModal.querySelector('.diag-copy').addEventListener('click', () => copy());
	diagModal.querySelector('.diag-download').addEventListener('click', () => download());
	await refresh();
}

function download() {
	const ta = document.getElementById('diag-textarea');
	const status = document.getElementById('diag-status');
	if (!ta) return;
	try {
		const blob = new Blob([ta.value], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		a.href = url;
		a.download = 'faces-diagnostic-' + myroomLabel + '-' + stamp + '.txt';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		if (status) status.textContent = 'Datei gespeichert.';
	} catch (e) {
		if (status) status.textContent = 'Speichern fehlgeschlagen: ' + ((e && e.message) || e);
	}
}

async function refresh() {
	const ta = document.getElementById('diag-textarea');
	const status = document.getElementById('diag-status');
	if (!ta) return;
	if (status) status.textContent = 'Bericht wird erstellt…';
	const report = await buildDiagnosticReport();
	ta.value = report;
	if (status) status.textContent = report.split('\n').length + ' Zeilen, ' + report.length + ' Zeichen';
}

async function copy() {
	const ta = document.getElementById('diag-textarea');
	const status = document.getElementById('diag-status');
	if (!ta) return;
	try {
		await navigator.clipboard.writeText(ta.value);
		if (status) status.textContent = 'In Zwischenablage kopiert.';
	} catch (e) {
		ta.select();
		try {
			document.execCommand('copy');
			if (status) status.textContent = 'In Zwischenablage kopiert.';
		} catch (err) {
			if (status) status.textContent = 'Kopieren fehlgeschlagen — bitte manuell markieren.';
		}
	}
}
