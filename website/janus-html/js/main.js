import { IS_INTERVIEWER, myroomLabel, state } from './state.js';
import { setupChatUI } from './chat.js';
import { setupAnswerOptionListener } from './answer-options.js';
import { setupAnswerAckIndicator } from './answer-ack-indicator.js';
import { setupRecordingUI } from './recording.js';
import { setupDeviceSelectors } from './devices.js';
import { setupFollowUpSurveyUI } from './followup.js';
import { setupGazeOverlayUI } from './gaze-overlay.js';
import { loadIncludes } from './includes.js';
import { showWelcomeGate } from './preinterview.js';
import { initDiagnostics, setupDiagnosticButton } from './diagnostics.js';
import { teardownJanus } from './videoroom.js';

initDiagnostics();

async function init() {
	await loadIncludes();
	$('#room-id-display').text(myroomLabel);
	$('#you').removeClass('hide').text(state.myusername);
	setupChatUI();
	setupAnswerOptionListener();
	setupDeviceSelectors();
	setupFollowUpSurveyUI();
	setupGazeOverlayUI();
	setupDiagnosticButton();
	if (IS_INTERVIEWER) {
		setupRecordingUI();
		setupAnswerAckIndicator();
	}

	showWelcomeGate();
}

document.addEventListener('DOMContentLoaded', () => {
	init();
});

// Detach cleanly on reload/navigation so the media server frees our publisher
// immediately instead of waiting for an ICE timeout. Without this, a quick
// reload leaves a stale publisher session that races with the fresh one and
// can break the rejoining peer's subscription. pagehide is more reliable than
// beforeunload on mobile browsers.
window.addEventListener('pagehide', teardownJanus);
