import { state, IS_INTERVIEWER } from './state.js';
import { unlockAudioPlayback } from './audio.js';
import { connectToJanus } from './videoroom.js';
import { warmUpSegmenter } from './virtualbg.js';

let preinterviewShown = false;
let welcomeGateShown = false;

// Welcome gate shown before the device modal. Its only job is to capture a real
// user gesture (a click/tap) BEFORE any getUserMedia / audio-unlock / Janus.init
// runs. Some browsers (notably mobile Safari/Chrome) will not resolve media
// playback or device promises until the page has had a user interaction — which
// is why the device modal's "Interview starten" button previously appeared stuck
// until the user happened to tap somewhere. Gating on an explicit button removes
// that ambiguity: by the time the device modal opens, the gesture already happened.
export function showWelcomeGate() {
	if (welcomeGateShown) return;
	welcomeGateShown = true;

	const overlay = document.createElement('div');
	overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4';
	overlay.innerHTML = `
		<div class="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden border border-gray-200">
			<div class="px-6 py-10 text-center">
				<div class="flex justify-center mb-5">
					<div class="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
						<i class="fas fa-video text-blue-600 text-2xl"></i>
					</div>
				</div>
				<h2 class="text-2xl font-semibold text-gray-900 mb-2">Willkommen</h2>
				<p class="text-gray-600 text-sm mb-8">Klicken Sie auf die Schaltfläche, um Ihre Geräte einzurichten und das Interview zu starten.</p>
				<button id="welcome-start" class="w-full px-4 py-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors shadow-lg flex items-center justify-center gap-2">
					<i class="fas fa-arrow-right"></i>
					<span>Hier klicken um das Interview zu starten</span>
				</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const startBtn = overlay.querySelector('#welcome-start');
	startBtn.addEventListener('click', () => {
		// This handler runs inside the user gesture. Remove the gate and open the
		// device modal synchronously so the gesture context carries through.
		overlay.remove();
		showPreInterviewSetup();
	}, { once: true });
}

function buildSelectHtml(id, items, fallbackPrefix) {
	return `<select id="${id}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
		${items.map((d, i) => `<option value="${d.deviceId}">${d.label || fallbackPrefix + (i + 1)}</option>`).join('')}
	</select>`;
}

function populateSelect(id, items, fallbackPrefix, savedId) {
	const sel = document.getElementById(id);
	if (!sel || !items.length) return;
	sel.innerHTML = items.map((d, i) =>
		`<option value="${d.deviceId}">${d.label || fallbackPrefix + (i + 1)}</option>`
	).join('');
	sel.value = savedId || items[0]?.deviceId || '';
	sel.disabled = false;
	sel.closest('div')?.classList.remove('opacity-50');
}

export async function showPreInterviewSetup() {
	if (preinterviewShown) return;
	preinterviewShown = true;

	// --- Render modal immediately, no waiting ---
	const modal = document.createElement('div');
	modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm';

	const modalContent = document.createElement('div');
	// Flex column capped to the viewport height: the scrollable region (header +
	// form) flexes and scrolls, while the footer button stays pinned at the bottom
	// so it is always reachable even on short mobile screens.
	modalContent.className = 'bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden border border-gray-200 flex flex-col max-h-[90vh]';

	// Scrollable region wrapping header + form. position:relative so the
	// "scroll for more" hint can be absolutely positioned against it.
	const scrollRegion = document.createElement('div');
	scrollRegion.className = 'relative overflow-y-auto flex-1 min-h-0';

	const header = document.createElement('div');
	header.className = 'px-6 py-8';
	header.innerHTML = `
		<div class="flex justify-center mb-4">
			<div class="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center">
				<i class="fas fa-microphone text-blue-600 text-xl"></i>
			</div>
		</div>
		<h2 class="text-2xl font-semibold text-gray-900 text-center mb-2">Interview starten</h2>
		<p class="text-gray-600 text-center text-sm mb-6">Bitte wählen Sie Ihre Geräte aus</p>
	`;

	const form = document.createElement('div');
	form.className = 'space-y-4 px-6';

	// Live camera preview — populated once getUserMedia resolves
	const previewWrap = document.createElement('div');
	previewWrap.className = 'w-full aspect-video bg-gray-900 rounded-lg overflow-hidden flex items-center justify-center';
	previewWrap.innerHTML = `
		<video id="preinterview-preview" class="w-full h-full object-cover" autoplay playsinline muted></video>
	`;
	form.appendChild(previewWrap);

	// Placeholder selects — populated after permissions are granted
	const selectClass = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm';
	const sinkIdSupported = typeof HTMLMediaElement.prototype.setSinkId === 'function';
	for (const [id, label] of [
		['preinterview-audio',  'Mikrofon'],
		['preinterview-video',  'Kamera'],
		['preinterview-output', 'Lautsprecher'],
	]) {
		if (id === 'preinterview-output' && !sinkIdSupported) continue;
		const div = document.createElement('div');
		div.className = 'opacity-50';
		div.innerHTML = `
			<label class="block text-sm font-medium text-gray-700 mb-2">${label}</label>
			<select id="${id}" class="${selectClass}" disabled>
				<option>Wird geladen…</option>
			</select>
		`;
		form.appendChild(div);
	}

	const bgDiv = document.createElement('div');
	const officeBtn = IS_INTERVIEWER
		? `<button data-vbg="office" class="preinterview-vbg-btn flex flex-col items-center justify-center gap-1 p-2 rounded-lg border border-gray-300 text-xs text-gray-600 hover:border-purple-400 hover:bg-purple-50 transition-colors">
				<i class="fas fa-building text-base"></i><span>VR</span>
			</button>`
		: '';
	bgDiv.innerHTML = `
		<label class="block text-sm font-medium text-gray-700 mb-2">Virtueller Hintergrund</label>
		<div id="preinterview-vbg-options" class="grid ${IS_INTERVIEWER ? 'grid-cols-3' : 'grid-cols-2'} gap-2">
			<button data-vbg="none"   class="preinterview-vbg-btn active flex flex-col items-center justify-center gap-1 p-2 rounded-lg border border-gray-300 text-xs text-gray-600 hover:border-purple-400 hover:bg-purple-50 transition-colors">
				<i class="fas fa-ban text-base"></i><span>Kein</span>
			</button>
			<button data-vbg="blur"   class="preinterview-vbg-btn flex flex-col items-center justify-center gap-1 p-2 rounded-lg border border-gray-300 text-xs text-gray-600 hover:border-purple-400 hover:bg-purple-50 transition-colors">
				<i class="fas fa-droplet text-base"></i><span>Blur</span>
			</button>
			${officeBtn}
		</div>
	`;
	form.appendChild(bgDiv);
	warmUpSegmenter();

	const cameraToggleDiv = document.createElement('div');
	cameraToggleDiv.className = 'flex items-center gap-3 mt-2';
	cameraToggleDiv.innerHTML = `
		<input type="checkbox" id="preinterview-camera-enabled" checked class="w-4 h-4 accent-blue-600 cursor-pointer">
		<label for="preinterview-camera-enabled" class="text-sm text-gray-700 cursor-pointer select-none">Kamera aktivieren</label>
	`;
	form.appendChild(cameraToggleDiv);

	const note = document.createElement('p');
	note.className = 'text-xs text-gray-500 mt-4 p-3 bg-gray-50 rounded-lg';
	note.textContent = 'Sie können Ihre Geräteeinstellungen jederzeit während des Interviews über das Zahnradsymbol ändern.';
	form.appendChild(note);

	const footer = document.createElement('div');
	footer.className = 'px-6 py-4 bg-gray-50 border-t border-gray-200 shrink-0';
	footer.innerHTML = `
		<button id="preinterview-confirm" disabled class="w-full px-4 py-3 rounded-lg bg-blue-300 text-white font-medium transition-colors cursor-not-allowed">
			<i class="fas fa-spinner fa-spin mr-2"></i>Geräte werden geladen…
		</button>
	`;

	// Hint that appears at the bottom edge of the scroll region while there is
	// more content below the fold. Hidden automatically once scrolled to bottom.
	const scrollHint = document.createElement('div');
	scrollHint.id = 'preinterview-scroll-hint';
	scrollHint.className = 'hide pointer-events-none sticky bottom-0 left-0 right-0 flex justify-center pb-1 pt-6 bg-gradient-to-t from-white to-transparent';
	scrollHint.innerHTML = `
		<span class="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-600 text-white text-xs font-medium shadow-lg animate-bounce">
			<i class="fas fa-chevron-down"></i> Nach unten scrollen
		</span>
	`;

	header.appendChild(form);
	scrollRegion.appendChild(header);
	scrollRegion.appendChild(scrollHint);
	modalContent.appendChild(scrollRegion);
	modalContent.appendChild(footer);
	modal.appendChild(modalContent);
	document.body.appendChild(modal);

	// --- Scroll hint: show while there is content below the fold ---
	// On short screens the device selectors + button extend past the viewport.
	// The footer button is pinned (always visible), but the selects above it may
	// be hidden; this nudges the user to scroll. Tapping the hint scrolls down.
	const updateScrollHint = () => {
		const hasOverflow = scrollRegion.scrollHeight - scrollRegion.clientHeight > 8;
		const atBottom = scrollRegion.scrollTop + scrollRegion.clientHeight >= scrollRegion.scrollHeight - 8;
		scrollHint.classList.toggle('hide', !hasOverflow || atBottom);
	};
	scrollRegion.addEventListener('scroll', updateScrollHint, { passive: true });
	scrollHint.addEventListener('click', () => {
		scrollRegion.scrollTo({ top: scrollRegion.scrollHeight, behavior: 'smooth' });
	});
	// Recompute when layout changes (selects populate, preview loads, rotation).
	if (typeof ResizeObserver === 'function') {
		const ro = new ResizeObserver(() => updateScrollHint());
		ro.observe(scrollRegion);
		if (header) ro.observe(header);
	}
	window.addEventListener('resize', updateScrollHint, { passive: true });
	// Initial check after first paint.
	requestAnimationFrame(updateScrollHint);

	// --- Wire up vbg buttons immediately ---
	const vbgContainer = document.getElementById('preinterview-vbg-options');
	if (vbgContainer) {
		const activateBtn = (mode) => {
			vbgContainer.querySelectorAll('.preinterview-vbg-btn').forEach((b) => {
				const on = b.dataset.vbg === mode;
				b.classList.toggle('active', on);
				b.classList.toggle('border-purple-500', on);
				b.classList.toggle('bg-purple-50', on);
				b.classList.toggle('text-purple-700', on);
			});
		};
		activateBtn(state.virtualBgMode || 'none');
		vbgContainer.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-vbg]');
			if (!btn) return;
			state.virtualBgMode = btn.dataset.vbg;
			activateBtn(state.virtualBgMode);
		});
	}

	// --- Dim camera row when checkbox is unchecked ---
	const cameraCheckbox = document.getElementById('preinterview-camera-enabled');
	const updateCameraRowOpacity = () => {
		const videoRow = document.getElementById('preinterview-video')?.closest('div');
		if (videoRow) videoRow.classList.toggle('opacity-50', !cameraCheckbox.checked);
	};
	cameraCheckbox.addEventListener('change', updateCameraRowOpacity);

	// --- Request permissions, keep stream alive, show live preview ---
	const previewEl = document.getElementById('preinterview-preview');
	(async () => {
		const wantCamera = cameraCheckbox.checked;
		try {
			state.preinterviewStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantCamera });
			if (previewEl) {
				previewEl.srcObject = state.preinterviewStream;
				previewEl.play().catch(() => {});
			}
			// Firefox sometimes returns a "live" video track that is actually frozen on
			// the last frame from a previous page load (recycled capture, no new permission
			// prompt). Detect this by checking whether currentTime advances within 2s;
			// if it doesn't, stop the stale track and open a fresh getUserMedia.
			if (wantCamera && previewEl) {
				await new Promise(resolve => setTimeout(resolve, 2000));
				if (previewEl.currentTime === 0 || previewEl.paused) {
					console.warn('[PREINTERVIEW] video track appears frozen/stale (currentTime=', previewEl.currentTime, ') — re-acquiring camera');
					const staleTrack = state.preinterviewStream.getVideoTracks()[0];
					if (staleTrack) {
						state.preinterviewStream.removeTrack(staleTrack);
						staleTrack.stop();
					}
					const freshStream = await navigator.mediaDevices.getUserMedia({ video: true });
					const freshTrack = freshStream.getVideoTracks()[0];
					if (freshTrack) {
						state.preinterviewStream.addTrack(freshTrack);
						previewEl.srcObject = state.preinterviewStream;
						previewEl.play().catch(() => {});
						console.debug('[PREINTERVIEW] fresh video track acquired after stale detection; readyState=', freshTrack.readyState);
					}
				} else {
					console.debug('[PREINTERVIEW] video track looks live (currentTime=', previewEl.currentTime, ')');
				}
			}
		} catch (err) {
			console.warn('Device permission request failed:', 'name=', err && err.name, 'message=', err && err.message);
		}
		const devices = await navigator.mediaDevices.enumerateDevices();
		populateSelect('preinterview-audio',  devices.filter(d => d.kind === 'audioinput'),  'Mikrofon ',     state.selectedAudioDeviceId);
		populateSelect('preinterview-video',  devices.filter(d => d.kind === 'videoinput'),  'Kamera ',       state.selectedVideoDeviceId);
		populateSelect('preinterview-output', devices.filter(d => d.kind === 'audiooutput'), 'Lautsprecher ', state.selectedOutputDeviceId);

		// When the user picks a different camera/mic, swap tracks on the live stream
		// without releasing the camera. Try applyConstraints first; fall back to
		// getUserMedia + replaceTrack if the browser refuses to switch device that way.
		async function swapTrack(kind, deviceId) {
			if (!state.preinterviewStream || !deviceId) return;
			const tracks = kind === 'video' ? state.preinterviewStream.getVideoTracks() : state.preinterviewStream.getAudioTracks();
			const existing = tracks[0];
			if (existing) {
				try {
					await existing.applyConstraints({ deviceId: { exact: deviceId } });
					return;
				} catch (e) {
					console.debug('[PREINTERVIEW] applyConstraints failed, falling back to getUserMedia', e && e.name);
				}
			}
			try {
				const constraints = kind === 'video'
					? { video: { deviceId: { exact: deviceId } }, audio: false }
					: { audio: { deviceId: { exact: deviceId } }, video: false };
				const newStream = await navigator.mediaDevices.getUserMedia(constraints);
				const newTrack = (kind === 'video' ? newStream.getVideoTracks() : newStream.getAudioTracks())[0];
				if (existing) {
					state.preinterviewStream.removeTrack(existing);
					existing.stop();
				}
				state.preinterviewStream.addTrack(newTrack);
				if (kind === 'video' && previewEl) {
					previewEl.srcObject = state.preinterviewStream;
					previewEl.play().catch(() => {});
				}
			} catch (e) {
				console.warn('[PREINTERVIEW] swapTrack fallback failed', e && e.name, e && e.message);
			}
		}

		const audioSel = document.getElementById('preinterview-audio');
		const videoSel = document.getElementById('preinterview-video');
		if (audioSel) audioSel.addEventListener('change', () => swapTrack('audio', audioSel.value));
		if (videoSel) videoSel.addEventListener('change', () => swapTrack('video', videoSel.value));

		const btn = document.getElementById('preinterview-confirm');
		if (btn) {
			btn.disabled = false;
			btn.className = 'w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors cursor-pointer';
			btn.innerHTML = 'Interview starten';
		}
	})();

	// --- Confirm ---
	const confirmBtn = document.getElementById('preinterview-confirm');
	confirmBtn.addEventListener('click', () => {
		const audioSelect  = document.getElementById('preinterview-audio');
		const videoSelect  = document.getElementById('preinterview-video');
		const outputSelect = document.getElementById('preinterview-output');
		const cameraEnabled = document.getElementById('preinterview-camera-enabled')?.checked ?? true;
		state.selectedAudioDeviceId  = audioSelect?.value  || '';
		state.selectedOutputDeviceId = outputSelect?.value || '';
		state.cameraEnabled = cameraEnabled;
		if (cameraEnabled) {
			state.selectedVideoDeviceId = videoSelect?.value || '';
		} else {
			state.selectedVideoDeviceId = '';
			// Drop the video track from the held stream so the camera is released
			if (state.preinterviewStream) {
				state.preinterviewStream.getVideoTracks().forEach((t) => {
					state.preinterviewStream.removeTrack(t);
					t.stop();
				});
			}
		}

		// Detach preview before the modal is removed, otherwise the <video> still
		// holds a ref to the stream we're about to hand to Janus.
		if (previewEl) previewEl.srcObject = null;
		modal.remove();
		unlockAudioPlayback();

		Janus.init({
			debug: 'warn',
			callback: function () {
				if (!Janus.isWebrtcSupported()) {
					bootbox.alert('No WebRTC support in this browser.');
					return;
				}
				connectToJanus();
			}
		});
	});
}
