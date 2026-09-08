import { state, IS_INTERVIEWER, myroom } from './state.js';
import { escapeHtml } from './utils.js';

const DEFAULT_OVERLAY_TEXT_TOPLEFT = 'Heute ist gutes...';
const DEFAULT_OVERLAY_TEXT_BOTTOMRIGHT = '...Wetter für ein Interview!';
let overlayActive = false;
let overlayElement = null;

function ensureOverlayElement() {
	if (overlayElement) return overlayElement;
	const overlay = document.createElement('div');
	overlay.className = 'absolute inset-0 z-40 bg-black/40 backdrop-blur-sm hide';
	overlay.innerHTML = `
		<div class="absolute top-6 left-6 max-w-[80%]">
			<div class="text-white text-xl sm:text-3xl font-semibold tracking-wide" id="gaze-overlay-text-tl"></div>
		</div>
		<div class="absolute bottom-6 right-6 max-w-[80%] text-right">
			<div class="text-white text-xl sm:text-3xl font-semibold tracking-wide" id="gaze-overlay-text-br"></div>
		</div>
	`;
	// Mount inside the video stage so the overlay only covers the video stream,
	// not the whole window. Fall back to body if the stage isn't present.
	const stage = document.getElementById('interviewer-stage') || document.body;
	stage.appendChild(overlay);
	overlayElement = overlay;
	return overlay;
}

function showOverlay(textTopLeft, textBottomRight) {
	const overlay = ensureOverlayElement();
	const textTopLeftNode = overlay.querySelector('#gaze-overlay-text-tl');
	const textBottomRightNode = overlay.querySelector('#gaze-overlay-text-br');
	if (textTopLeftNode) textTopLeftNode.innerHTML = escapeHtml(textTopLeft || DEFAULT_OVERLAY_TEXT_TOPLEFT);
	if (textBottomRightNode) textBottomRightNode.innerHTML = escapeHtml(textBottomRight || DEFAULT_OVERLAY_TEXT_BOTTOMRIGHT);
	overlay.classList.remove('hide');
}

function hideOverlay() {
	if (overlayElement) overlayElement.classList.add('hide');
}

function sendOverlayMessage(show, textTopLeft, textBottomRight) {
	if (!state.textHandle || !state.chatReady) {
		toastr && toastr.warning('Chat verbindet noch…');
		return false;
	}
	const payload = {
		kind: 'gaze_overlay',
		show: !!show,
		textTopLeft: textTopLeft || DEFAULT_OVERLAY_TEXT_TOPLEFT,
		textBottomRight: textBottomRight || DEFAULT_OVERLAY_TEXT_BOTTOMRIGHT
	};
	const message = {
		textroom: 'message',
		transaction: Janus.randomString(12),
		room: myroom,
		text: JSON.stringify(payload),
		ack: false
	};
	state.textHandle.data({
		text: JSON.stringify(message),
		error: (reason) => {
			console.error('Gaze overlay send error:', reason);
			toastr && toastr.error('Kalibrierung konnte nicht gesendet werden.');
		}
	});
	return true;
}

export function setupGazeOverlayUI() {
	if (!IS_INTERVIEWER) return;
	const button = document.getElementById('gaze-overlay-toggle');
	if (!button) return;

	const updateButton = () => {
		if (overlayActive) {
			button.classList.remove('bg-purple-100', 'text-purple-700');
			button.classList.add('bg-purple-600', 'text-white');
			button.innerHTML = '<i class="fas fa-bullseye"></i><span>Kalibrierung aus</span>';
		} else {
			button.classList.remove('bg-purple-600', 'text-white');
			button.classList.add('bg-purple-100', 'text-purple-700');
			button.innerHTML = '<i class="fas fa-bullseye"></i><span>Kalibrierung</span>';
		}
	};

	updateButton();
	button.addEventListener('click', () => {
		const textTopLeft = button.dataset.overlayTextTl || DEFAULT_OVERLAY_TEXT_TOPLEFT;
		const textBottomRight = button.dataset.overlayTextBr || DEFAULT_OVERLAY_TEXT_BOTTOMRIGHT;
		const nextState = !overlayActive;
		if (!sendOverlayMessage(nextState, textTopLeft, textBottomRight)) return;
		overlayActive = nextState;
		updateButton();
	});
}

export function handleGazeOverlayMessage(payload) {
	if (!payload) return;
	if (payload.show) {
		showOverlay(payload.textTopLeft, payload.textBottomRight);
	} else {
		hideOverlay();
	}
}
