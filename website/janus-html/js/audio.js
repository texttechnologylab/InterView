import { state } from './state.js';

export function unlockAudioPlayback() {
	if (state.audioUnlocked) return;
	state.audioUnlocked = true;
	const audios = document.querySelectorAll('audio');
	audios.forEach((audio) => {
		const playPromise = audio.play();
		if (playPromise && typeof playPromise.catch === 'function') {
			playPromise.catch(() => {});
		}
	});
}

export function setupAudioUnlockListeners() {
	const unlockOnce = () => {
		unlockAudioPlayback();
		document.removeEventListener('click', unlockOnce);
		document.removeEventListener('keydown', unlockOnce);
		document.removeEventListener('touchstart', unlockOnce);
	};
	document.addEventListener('click', unlockOnce, { once: true });
	document.addEventListener('keydown', unlockOnce, { once: true });
	document.addEventListener('touchstart', unlockOnce, { once: true });
}
