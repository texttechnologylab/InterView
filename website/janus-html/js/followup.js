import { state, IS_INTERVIEWER, myroom, myroomLabel } from './state.js';

const FOLLOWUP_SURVEY_URL = 'https://survey.example.org/1260000';

function withToken(url, token) {
	if (!token) return url;
	const sep = url.includes('?') ? '&' : '?';
	return url + sep + 'token=' + encodeURIComponent(token);
}

export function setupFollowUpSurveyUI() {
	const button = document.getElementById('send-followup');
	if (!IS_INTERVIEWER) return;
	if (!button) return;

	button.addEventListener('click', () => {
		const url = withToken(FOLLOWUP_SURVEY_URL, String(myroomLabel));
		sendFollowUpSurvey(url);
		toastr && toastr.success('Nachbefragung gesendet.');
	});
}

export function sendFollowUpSurvey(url) {
	if (!state.textHandle || !state.chatReady) {
		toastr && toastr.warning('Chat verbindet noch…');
		return;
	}
	const payload = { kind: 'followup_survey', url: url };
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
			console.error('Follow-up send error:', reason);
			toastr && toastr.error('Nachbefragung konnte nicht gesendet werden.');
		}
	});
}

export function handleFollowUpSurvey(url) {
	if (!url) return;

	const modal = document.createElement('div');
	modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm';
	modal.innerHTML = `
		<div class="bg-white rounded-2xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden border border-gray-200">
			<div class="px-6 py-8">
				<div class="flex justify-center mb-4">
					<div class="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
						<i class="fas fa-clipboard-list text-blue-600 text-lg"></i>
					</div>
				</div>
				<h2 class="text-xl font-semibold text-gray-900 text-center mb-2">Nachbefragung</h2>
				<p class="text-gray-600 text-center text-sm">Möchten Sie jetzt an der Nachbefragung teilnehmen?</p>
			</div>
			<div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
				<button class="followup-cancel flex-1 px-4 py-2.5 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium text-sm transition-colors">
					Später
				</button>
				<button class="followup-open flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors">
					Öffnen
				</button>
			</div>
		</div>
	`;

	document.body.appendChild(modal);

	const openBtn = modal.querySelector('.followup-open');
	const cancelBtn = modal.querySelector('.followup-cancel');

	const closeModal = () => modal.remove();

	openBtn.addEventListener('click', () => {
		window.open(url, '_blank', 'noopener');
		closeModal();
	});

	cancelBtn.addEventListener('click', closeModal);

	modal.addEventListener('click', (e) => {
		if (e.target === modal) closeModal();
	});
}
