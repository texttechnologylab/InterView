import { state, myroom, IS_INTERVIEWER } from './state.js';

// The recording signal rides the (sometimes flaky) text data channel, so a
// single fire-and-forget broadcast can be missed. While recording is active we
// re-announce on a heartbeat so the participant's REC indicator converges even
// if the toggle message was dropped or their channel was briefly down.
const RECORDING_HEARTBEAT_MS = 10000;
let recordingHeartbeat = null;

function startRecordingHeartbeat() {
	if (recordingHeartbeat) return;
	recordingHeartbeat = setInterval(() => {
		if (!state.recording) { stopRecordingHeartbeat(); return; }
		broadcastRecordingState();
	}, RECORDING_HEARTBEAT_MS);
}

function stopRecordingHeartbeat() {
	if (recordingHeartbeat) { clearInterval(recordingHeartbeat); recordingHeartbeat = null; }
}

export function setupRecordingUI() {
	const btn = document.getElementById('record-btn');
	if (!btn) return;
	btn.addEventListener('click', toggleRecording);
}

export function toggleRecording() {
	if (!state.sfutest) return;
	const next = !state.recording;
	const body = { request: 'enable_recording', room: myroom, record: next };
	state.sfutest.send({
		message: body,
		success: () => {
			state.recording = next;
			updateRecordingUI();
			broadcastRecordingState();
			if (next) startRecordingHeartbeat(); else stopRecordingHeartbeat();
			toastr && toastr[next ? 'success' : 'info'](next ? 'Aufnahme gestartet' : 'Aufnahme gestoppt');
		},
		error: (err) => {
			console.error('Recording toggle failed', err);
			toastr && toastr.error('Fehler beim Umschalten der Aufnahme: ' + (err.error || err));
		}
	});
}

// Recording is interviewer-controlled and the videoroom plugin doesn't reliably
// notify other participants, so we relay the state over the text data channel.
// The interviewee mirrors it onto its own #record-dot. Interviewer-only and
// best-effort: if the channel isn't ready yet, a fresh broadcast on the
// participant's chat-join (see textroom.js) catches them up.
export function broadcastRecordingState() {
	if (!IS_INTERVIEWER) return;
	if (!state.textHandle || !state.chatReady) return;
	const payload = { kind: 'recording', active: !!state.recording };
	const message = {
		textroom: 'message',
		transaction: Janus.randomString(12),
		room: myroom,
		text: JSON.stringify(payload),
		ack: false
	};
	try {
		state.textHandle.data({
			text: JSON.stringify(message),
			error: (reason) => console.warn('[RECORDING] state broadcast error', reason)
		});
	} catch (e) {
		console.warn('[RECORDING] state broadcast threw', e && e.message);
	}
}

export function updateRecordingUI() {
	const btn = document.getElementById('record-btn');
	const dot = document.getElementById('record-dot');
	if (btn) {
		btn.classList.toggle('bg-red-600', state.recording);
		btn.classList.toggle('hover:bg-red-700', state.recording);
		btn.classList.toggle('bg-gray-200', !state.recording);
		btn.classList.toggle('text-gray-700', !state.recording);
		btn.classList.toggle('text-white', state.recording);
		const label = btn.querySelector('.record-label');
		if (label) label.textContent = state.recording ? 'Aufnahme stoppen' : 'Aufnehmen';
	}
	if (dot) dot.classList.toggle('hide', !state.recording);
}
