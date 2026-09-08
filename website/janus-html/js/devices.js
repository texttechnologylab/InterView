import { state } from './state.js';
import { republishOwnFeed, applyOutputDeviceToAll } from './videoroom.js';

function setSelectOptions(select, devices, kind) {
	if (!select) return;
	select.innerHTML = '';
	if (!devices.length) {
		const opt = document.createElement('option');
		opt.value = '';
		if (kind === 'audioinput') opt.textContent = 'Keine Mikrofone gefunden';
		else if (kind === 'videoinput') opt.textContent = 'Keine Kameras gefunden';
		else opt.textContent = 'Keine Lautsprecher gefunden';
		select.appendChild(opt);
		select.disabled = true;
		return;
	}
	select.disabled = false;
	devices.forEach((device, idx) => {
		const opt = document.createElement('option');
		opt.value = device.deviceId;
		let fallback = '';
		if (kind === 'audioinput') fallback = 'Mikrofon ';
		else if (kind === 'videoinput') fallback = 'Kamera ';
		else fallback = 'Lautsprecher ';
		const label = device.label || (fallback + (idx + 1));
		opt.textContent = label;
		select.appendChild(opt);
	});
}

async function requestDeviceLabels() {
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
		stream.getTracks().forEach((track) => track.stop());
	} catch (err) {
		console.warn('Device permission not granted:', 'name=', err && err.name, 'message=', err && err.message);
	}
}

async function refreshDeviceLists() {
	if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
	await requestDeviceLabels();
	const devices = await navigator.mediaDevices.enumerateDevices();
	const audioInputs = devices.filter((d) => d.kind === 'audioinput');
	const videoInputs = devices.filter((d) => d.kind === 'videoinput');
	const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

	const audioSelect = document.getElementById('audio-device-select');
	const videoSelect = document.getElementById('video-device-select');
	const outputSelect = document.getElementById('output-device-select');

	setSelectOptions(audioSelect, audioInputs, 'audioinput');
	setSelectOptions(videoSelect, videoInputs, 'videoinput');
	setSelectOptions(outputSelect, audioOutputs, 'audiooutput');

	if (audioSelect && state.selectedAudioDeviceId) {
		audioSelect.value = state.selectedAudioDeviceId;
	}
	if (videoSelect && state.selectedVideoDeviceId) {
		videoSelect.value = state.selectedVideoDeviceId;
	}
	if (outputSelect && state.selectedOutputDeviceId) {
		outputSelect.value = state.selectedOutputDeviceId;
	}
}

export function setupDeviceSelectors() {
	const audioSelect = document.getElementById('audio-device-select');
	const videoSelect = document.getElementById('video-device-select');
	const outputSelect = document.getElementById('output-device-select');
	const applyBtn = document.getElementById('apply-devices');
	const deviceToggle = document.getElementById('device-toggle');
	const popover = document.getElementById('device-popover');
	if (!audioSelect && !videoSelect && !outputSelect && !applyBtn) return;

	if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
		navigator.mediaDevices.addEventListener('devicechange', refreshDeviceLists);
	}

	if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') {
		document.getElementById('output-device-row')?.classList.add('hidden');
	}

	setupVirtualBgButtons();

	const cameraToggle = document.getElementById('camera-enabled-toggle');

	function syncCameraToggle() {
		if (!cameraToggle) return;
		cameraToggle.checked = state.cameraEnabled;
		if (videoSelect) document.getElementById('camera-device-row')?.classList.toggle('opacity-50', !state.cameraEnabled);
	}

	if (cameraToggle) {
		cameraToggle.addEventListener('change', () => {
			document.getElementById('camera-device-row')?.classList.toggle('opacity-50', !cameraToggle.checked);
		});
	}

	if (applyBtn) {
		applyBtn.addEventListener('click', () => {
			state.selectedAudioDeviceId = audioSelect ? audioSelect.value : '';
			state.selectedOutputDeviceId = outputSelect ? outputSelect.value : '';
			state.cameraEnabled = cameraToggle ? cameraToggle.checked : true;
			state.selectedVideoDeviceId = (state.cameraEnabled && videoSelect) ? videoSelect.value : '';
			republishOwnFeed();
			applyOutputDeviceToAll();
			if (popover) popover.classList.add('hide');
		});
	}

	if (deviceToggle && popover) {
		deviceToggle.addEventListener('click', () => {
			popover.classList.toggle('hide');
			if (!popover.classList.contains('hide')) {
				refreshDeviceLists();
				syncCameraToggle();
				syncVirtualBgButtons();
			}
		});
		document.addEventListener('click', (event) => {
			if (popover.classList.contains('hide')) return;
			if (popover.contains(event.target) || deviceToggle.contains(event.target)) return;
			popover.classList.add('hide');
		});
	}
}

function syncVirtualBgButtons() {
	const container = document.getElementById('vbg-options');
	if (!container) return;
	const current = state.virtualBgMode || 'none';
	container.querySelectorAll('.vbg-btn').forEach((b) => {
		const on = b.dataset.vbg === current;
		b.classList.toggle('active', on);
		b.classList.toggle('border-purple-500', on);
		b.classList.toggle('bg-purple-50', on);
		b.classList.toggle('text-purple-700', on);
	});
}

function setupVirtualBgButtons() {
	const container = document.getElementById('vbg-options');
	if (!container) return;

	container.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-vbg]');
		if (!btn) return;
		state.virtualBgMode = btn.dataset.vbg;
		syncVirtualBgButtons();
	});

	syncVirtualBgButtons();
}
