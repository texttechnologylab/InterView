import { state, IS_INTERVIEWER, myroom } from './state.js';
import { nowTime } from './utils.js';

let unreadCount = 0;

function updateUnreadBadge() {
	const badge = document.getElementById('chat-unread-count');
	if (!badge) return;
	if (unreadCount > 0) {
		badge.textContent = String(unreadCount);
		badge.classList.remove('hide');
	} else {
		badge.classList.add('hide');
	}
}

export function incrementUnread() {
	unreadCount += 1;
	const toggle = document.getElementById('chat-toggle');
	if (toggle) toggle.classList.add('chat-unread');
	updateUnreadBadge();
}

export function clearUnread() {
	unreadCount = 0;
	const toggle = document.getElementById('chat-toggle');
	if (toggle) toggle.classList.remove('chat-unread');
	updateUnreadBadge();
}

export function openChatPanel() {
	const panel = document.getElementById('chat-panel');
	const toggle = document.getElementById('chat-toggle');
	const input = document.getElementById('chat-input');
	if (!panel || !panel.classList.contains('hide')) return;
	panel.classList.remove('hide');
	if (toggle) {
		toggle.classList.add('chat-active');
		toggle.classList.remove('chat-unread');
	}
	clearUnread();
	if (input) input.focus();
}

function appendLinkifiedText(container, text) {
	const urlRegex = /(https?:\/\/[^\s]+)/g;
	let lastIndex = 0;
	let match;
	while ((match = urlRegex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
		}
		const url = match[0];
		const link = document.createElement('a');
		link.href = url;
		link.textContent = url;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		link.className = 'underline';
		container.appendChild(link);
		lastIndex = match.index + url.length;
	}
	if (lastIndex < text.length) {
		container.appendChild(document.createTextNode(text.slice(lastIndex)));
	}
}

export function appendChatMessage({ from, text, mine, system }) {
	const box = document.getElementById('chat-messages');
	if (!box) return;
	const wrap = document.createElement('div');
	if (system) {
		wrap.className = 'text-center text-xs text-gray-500 italic my-2';
		wrap.textContent = text;
	} else {
		wrap.className = 'flex flex-col mb-3 ' + (mine ? 'items-end' : 'items-start');
		const meta = document.createElement('div');
		meta.className = 'text-xs text-gray-500 mb-1';
		meta.textContent = (mine ? 'Sie' : (from || 'Andere')) + ' • ' + nowTime();
		const bubble = document.createElement('div');
		const bg = mine
			? (IS_INTERVIEWER ? 'bg-purple-600' : 'bg-blue-600')
			: 'bg-gray-200 text-gray-800';
		bubble.className = 'max-w-[85%] px-3 py-2 rounded-2xl text-sm break-words ' +
			(mine ? bg + ' text-white rounded-br-sm' : bg + ' rounded-bl-sm');
		appendLinkifiedText(bubble, text);
		wrap.appendChild(meta);
		wrap.appendChild(bubble);
	}
	box.appendChild(wrap);
	box.scrollTop = box.scrollHeight;
}

// Visual state for the local answer-option notice. Mirrors the ack state machine
// in ack-tracker.js: a batch starts 'pending' (sent, awaiting the participant's
// confirmation) and only claims to be "angezeigt" once the ack actually arrives.
const ANSWER_OPT_STATES = {
	pending: {
		icon: 'fa-circle-notch fa-spin', tone: 'text-gray-500',
		border: 'border-gray-200', bg: 'bg-gray-50'
	},
	acked: {
		icon: 'fa-check-circle', tone: 'text-green-700',
		border: 'border-green-200', bg: 'bg-green-50'
	},
	failed: {
		icon: 'fa-triangle-exclamation', tone: 'text-orange-700',
		border: 'border-orange-200', bg: 'bg-orange-50'
	}
};

// Two flavours of notice. 'suppressed' is used when the answer-option filter
// deliberately resolved the batch to "answer freely": that IS a successful
// delivery, and labelling it as such is what stops the interviewer from reading
// a hidden batch as a transport failure.
const ANSWER_OPT_LABELS = {
	options: {
		pending: 'Antwortoptionen werden gesendet …',
		acked: 'Antwortoptionen angezeigt',
		failed: 'Anzeige nicht bestätigt'
	},
	suppressed: {
		pending: 'Freie Antwort wird gesendet …',
		acked: 'Als freie Antwort angezeigt',
		failed: 'Anzeige nicht bestätigt'
	}
};

function applyAnswerOptState(wrap, status) {
	const st = ANSWER_OPT_STATES[status] || ANSWER_OPT_STATES.pending;
	const kind = wrap.dataset.noticeKind === 'suppressed' ? 'suppressed' : 'options';
	const labels = ANSWER_OPT_LABELS[kind];
	wrap.className = 'answer-opt-notice my-2 mx-auto w-[90%] rounded-lg px-3 py-2 border ' + st.border + ' ' + st.bg;
	const title = wrap.querySelector('.answer-opt-title');
	const icon = wrap.querySelector('.answer-opt-icon');
	const label = wrap.querySelector('.answer-opt-label');
	if (title) title.className = 'answer-opt-title text-xs font-medium mb-1 flex items-center gap-1.5 ' + st.tone;
	if (icon) icon.className = 'answer-opt-icon fas ' + st.icon + ' ' + st.tone;
	if (label) label.textContent = labels[status] || labels.pending;
}

// Local-only echo of the answer options the interviewer sent to the participant.
// Rendered as a distinct notice block in the interviewer's own chat so they have
// a running record — this is NEVER sent over the data channel. Starts in the
// 'pending' state and is later flipped to 'acked'/'failed' by
// updateLocalAnswerOptionsStatus once the participant's ack arrives (or times
// out), so the message reflects the real confirmation, not an assumption.
export function appendLocalAnswerOptions(msgId, lines, opts) {
	const box = document.getElementById('chat-messages');
	if (!box || !Array.isArray(lines) || !lines.length) return;
	const wrap = document.createElement('div');
	if (msgId) wrap.dataset.ackId = msgId;
	wrap.dataset.noticeKind = (opts && opts.kind === 'suppressed') ? 'suppressed' : 'options';
	const title = document.createElement('div');
	title.className = 'answer-opt-title';
	const icon = document.createElement('i');
	icon.className = 'answer-opt-icon';
	const label = document.createElement('span');
	label.className = 'answer-opt-label';
	title.appendChild(icon);
	title.appendChild(label);
	wrap.appendChild(title);
	const ul = document.createElement('ul');
	ul.className = 'text-xs text-gray-600 space-y-0.5 list-disc list-inside';
	lines.forEach((line) => {
		const li = document.createElement('li');
		li.textContent = line;
		ul.appendChild(li);
	});
	wrap.appendChild(ul);
	box.appendChild(wrap);
	applyAnswerOptState(wrap, 'pending');
	box.scrollTop = box.scrollHeight;
}

// Flip a previously-appended notice to reflect the ack tracker's status for that
// batch. No-op if there is no local notice for this msgId (e.g. a silent re-push).
export function updateLocalAnswerOptionsStatus(msgId, status) {
	if (!msgId) return;
	const box = document.getElementById('chat-messages');
	if (!box) return;
	const sel = (window.CSS && CSS.escape) ? CSS.escape(msgId) : msgId;
	const wrap = box.querySelector('[data-ack-id="' + sel + '"]');
	if (wrap) applyAnswerOptState(wrap, status);
}

export function sendChatMessage() {
	const input = document.getElementById('chat-input');
	if (!input) return;
	const text = (input.value || '').trim();
	if (!text) return;
	if (!state.textHandle || !state.chatReady) {
		toastr && toastr.warning('Chat verbindet noch…');
		return;
	}
	const message = {
		textroom: 'message',
		transaction: Janus.randomString(12),
		room: myroom,
		text: text,
		ack: false
	};
	state.textHandle.data({
		text: JSON.stringify(message),
		error: (reason) => {
			console.error('Chat send error:', reason);
			toastr && toastr.error('Chat send fehlgeschlagen');
		},
		success: () => {
			appendChatMessage({ text, mine: true });
			input.value = '';
		}
	});
}

export function setupChatUI() {
	const toggle = document.getElementById('chat-toggle');
	const panel = document.getElementById('chat-panel');
	const sendBtn = document.getElementById('chat-send');
	const input = document.getElementById('chat-input');

	if (toggle && panel) {
		toggle.addEventListener('click', () => {
			panel.classList.toggle('hide');
			toggle.classList.toggle('chat-active');
			if (!panel.classList.contains('hide')) {
				clearUnread();
				if (input) input.focus();
			}
		});
	}
	if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);
	if (input) {
		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendChatMessage();
			}
		});
	}
}
