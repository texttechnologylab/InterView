import { state, IS_INTERVIEWER, myroom, ANSWER_OPTIONS_ALLOWED_ORIGINS } from './state.js';
import { AckTracker } from './ack-tracker.js';
import { notifyAnswerAck, setAnswerAckClearer } from './answer-ack-indicator.js';
import { appendLocalAnswerOptions, updateLocalAnswerOptionsStatus } from './chat.js';

// Interviewer-side tracker for answer-option batches we've sent. The indicator
// UI subscribes via notifyAnswerAck. Created lazily on first send so non-
// interviewer pages never instantiate it.
let answerAckTracker = null;

// Identifies this page load. The interviewee resets its de-duplication state
// whenever this changes, because an interviewer reload restarts answerSeq at
// zero — without the epoch, every batch sent after a reload would look "stale"
// to the participant and be silently discarded (while still being acked, so the
// interviewer saw a green confirmation for something never displayed).
const ANSWER_EPOCH = Janus.randomString(8);

// Content revision, NOT a packet counter. It only advances when the questionnaire
// supplies a new batch; retries, the heartbeat and rejoin re-pushes all carry the
// revision of the batch they are re-delivering. That makes every redelivery
// idempotent on the receiving side: a duplicate is dropped without re-rendering,
// while a first delivery still gets through.
let answerSeq = 0;

// The batch the participant should currently be seeing. Retries, the heartbeat
// and rejoin re-pushes all re-deliver THIS, reusing its revision and msgId
// rather than minting new ones — otherwise the ack chip would inflate with one
// entry per packet and the interviewer's chat would fill with duplicate notices.
let currentBatch = null;

let retryTimers = [];
let heartbeatTimer = null;

// Retransmission schedule for an unacknowledged batch, measured from the first
// transmission. The ack budget is longer than the last retry so the tracker only
// reports failure once every attempt has actually had a chance to be answered.
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const ACK_BUDGET_MS = 20000;

// Answer options are a STATE ("which options apply right now"), not an event.
// A slow re-announce lets that state converge on the participant's screen even
// when every delivery attempt for a batch was lost — e.g. their channel was down
// for the whole retry window. Duplicates cost one small message and are dropped
// by the receiver's revision guard. Same pattern as the recording heartbeat.
const HEARTBEAT_MS = 15000;

// Above this many concrete options we show nothing and let the participant answer
// freely — long lists don't fit the sidebar and aren't read aloud anyway.
const MAX_DISPLAYED_OPTIONS = 6;

function getAckTracker() {
	if (!answerAckTracker) {
		answerAckTracker = new AckTracker({
			timeoutMs: ACK_BUDGET_MS,
			idPrefix: 'ao',
			onChange: (entries) => {
				notifyAnswerAck(entries);
				// Keep the per-batch chat echo in sync with the real ack status, so
				// the local notice flips from "wird gesendet" to "angezeigt" only
				// once the participant actually confirms (or to "nicht bestätigt" on
				// timeout). Batches without a local notice are silently skipped.
				for (const entry of entries) updateLocalAnswerOptionsStatus(entry.id, entry.status);
			}
		});
		// Let the indicator tell the tracker to drop transient "isNew" emphasis
		// flags once it has finished animating them.
		setAnswerAckClearer(() => answerAckTracker.clearNewFlags());
	}
	return answerAckTracker;
}

// Build a short human label for an answer-option batch so the interviewer's
// ack tooltip can show *which* categories were sent, not just a count.
function summarizeBatch(data) {
	const items = Array.isArray(data) ? data : (data && data.items ? data.items : [data]);
	const labels = items.map((item) => {
		if (typeof item === 'string') return item;
		return (item && (item.label || item.text || item.value || item.name)) || '';
	}).map((s) => String(s).split('\n')[0].trim()).filter(Boolean);
	const count = labels.length;
	const preview = labels.slice(0, 3).join(', ');
	const more = count > 3 ? ` … (+${count - 3})` : '';
	return { count, label: (preview + more) || ('Antwortoptionen (' + count + ')') };
}

// Coerce the raw answer-option payload (array, {items:[…]}, or single value) into
// a flat array of display strings. Shared by the interviewee renderer and the
// interviewer-side displayability check so both sides agree on the input.
function normalizeAnswerData(data) {
	const items = Array.isArray(data) ? data : (data && data.items ? data.items : [data]);
	return items.map((item) => {
		const label = typeof item === 'string'
			? item
			: (item && (item.label || item.text || item.value || item.name)) || JSON.stringify(item);
		return String(label || '');
	});
}

// Mirror the interviewee's filtering on the interviewer side: returns the array
// of entries that would actually be DISPLAYED as concrete options on the
// participant's screen, or null when the batch resolves to "no concrete options"
// (free-answer case). Lets the interviewer treat a batch as "displayed" only
// when something concrete really shows up on the other end.
export function getDisplayableOptions(data) {
	return filterAnswerOptions(normalizeAnswerData(data));
}

// Build the one-liner(s) the interviewer's own chat echoes for a displayed batch.
// Collapses an 11-point numeric scale into a single readable line; otherwise one
// line per option (second descriptive line stripped, like the rendered rows).
function answerOptionLines(displayable) {
	if (isNumericScale(displayable) && displayable.length === 11) {
		const low = parseScaleEntry(displayable[0]);
		const high = parseScaleEntry(displayable[10]);
		const ends = (low.label || high.label)
			? ` (${low.label || low.num} … ${high.label || high.num})`
			: '';
		return ['Skala 0–10' + ends];
	}
	return displayable.map((e) => filterText(e).trim()).filter(Boolean);
}

export function renderAnswerOptions(data) {
	const panel = document.getElementById('answer-options');
	if (!panel) return;
	panel.innerHTML = '';
	const list = document.createElement('div');
	list.className = 'space-y-2';

	const filtered = filterAnswerOptions(normalizeAnswerData(data));
	if (filtered === null) {
		const note = document.createElement('div');
		note.className = 'text-center text-gray-500 mt-8 px-4 text-sm';
		note.textContent = 'Es sind keine konkreten Antwortoptionen vorhanden. Bitte antworten Sie ggf. frei.';
		panel.appendChild(note);
		return;
	}

	if (!filtered.length) {
		const empty = document.createElement('div');
		empty.className = 'text-center text-gray-400 mt-8';
		empty.textContent = 'Noch keine Antwortoptionen erhalten.';
		panel.appendChild(empty);
		return;
	}

	if (isNumericScale(filtered) && filtered.length === 11) {
		list.appendChild(buildNumericScale(filtered));
	} else {
		filtered.forEach((textEntry) => {
			const row = document.createElement('div');
			row.className = 'border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white shadow-sm';
			row.textContent = filterText(textEntry);
			list.appendChild(row);
		});
	}

	panel.appendChild(list);
}

// Question types whose option lists are deliberately NOT shown to the
// participant — either because the interviewer reads them aloud, or because
// seeing the brackets would bias the answer (income, employment status).
//
// These are anchored regexes, not substring tests. The previous `includes()`
// checks fired on ordinary words that merely contained the token: 'ja' matched
// "Jahre" and "Januar", 'euro' matched "Europa", 'ledig' matched "lediglich",
// 'gerät' matched inside longer words. A single accidental hit suppressed the
// whole batch, which on the interviewer's side is indistinguishable from a
// delivery failure — so it made the real transport problem harder to diagnose.
//
// Tests run against the lower-cased entry. Keep them free of the /g flag: a
// stateful regex would skip every other call.
const SUPPRESSION_RULES = [
	{ name: 'zp-statement',   label: 'ZP-Angabe',            test: /\bzp\b/ },
	{ name: 'interviewer',    label: 'Interviewer-Hinweis',  test: /\binterviewer/ },
	{ name: 'marital-status', label: 'Familienstand',        test: /\bledig\b/ },
	{ name: 'yes-no',         label: 'Ja/Nein-Frage',        test: /\bja\b/ },
	{ name: 'hours',          label: 'Stundenangabe',        test: /stunden\b/ },
	// Prefix match, so compounds like "Gerätetyp" still hit (the old substring
	// test caught those). Requiring the umlaut keeps the unrelated verb
	// "geraten" out, which a bare /\bgerat/ would have swept up.
	{ name: 'device',         label: 'Gerätetyp',            test: /\bger(?:ä|ae)t/ },
	{ name: 'device',         label: 'Gerätetyp',            test: /\bsmartphone/ },
	{ name: 'education',      label: 'Bildungsabschluss',    test: /\bdiplom/ },
	{ name: 'employment',     label: 'Erwerbstätigkeit',     test: /\berw[eä]rbst[äa]tig/ },
	{ name: 'open-bound',     label: 'Offene Kategoriegrenze', test: /\bweniger als\b/ },
	{ name: 'not-stated',     label: 'Nicht-genannt-Kategorie', test: /\bnicht genannt\b/ },
	{ name: 'income',         label: 'Einkommensklasse',     test: /\beuros?\b/ }
];

// Entries that are dropped from the list but don't suppress the whole batch.
const DROPPED_ENTRY = /wei(?:ß|ss)\s*nicht|undefined/;

function findSuppressionRule(entries) {
	for (const textEntry of entries) {
		if (!textEntry || !textEntry.trim()) continue;
		const lowered = textEntry.toLowerCase();
		for (const rule of SUPPRESSION_RULES) {
			if (rule.test.test(lowered)) return rule;
		}
	}
	return null;
}

function filterAnswerOptions(entries) {
	if (findSuppressionRule(entries)) return null;
	const filtered = [];
	for (const textEntry of entries) {
		if (!textEntry || !textEntry.trim()) continue;
		if (DROPPED_ENTRY.test(textEntry.toLowerCase())) continue;
		filtered.push(textEntry);
	}
	if (filtered.length > MAX_DISPLAYED_OPTIONS && !isNumericScale(filtered)) return null;
	return filtered;
}

// Explain, in one short phrase, why a batch resolved to "no concrete options".
// Shown in the interviewer's own chat so a deliberately suppressed batch can
// never be mistaken for one that failed to arrive.
function describeSuppression(data) {
	const entries = normalizeAnswerData(data);
	const rule = findSuppressionRule(entries);
	if (rule) return rule.label;
	const kept = entries.filter((e) => e && e.trim() && !DROPPED_ENTRY.test(e.toLowerCase()));
	if (kept.length > MAX_DISPLAYED_OPTIONS && !isNumericScale(kept)) {
		return 'zu viele Optionen (' + kept.length + ')';
	}
	return 'keine verwertbaren Einträge';
}

// Split a scale entry like "0 - ganz und gar unzufrieden" into its leading
// number and the descriptive anchor text. Falls back gracefully if the dash/
// separator isn't present.
function parseScaleEntry(text) {
	const firstLine = filterText(text).trim();
	const m = firstLine.match(/^(\d+)\s*[-–—:.]?\s*(.*)$/);
	if (m) return { num: m[1], label: m[2].trim() };
	return { num: firstLine, label: '' };
}

// Render an 11-point (0–10) numeric scale as a horizontal row of numbered
// cells with the two endpoint anchor labels above the ends. Fits the narrow
// sidebar by using a flex row of small squares; only 0 and 10 carry text.
function buildNumericScale(entries) {
	const wrap = document.createElement('div');
	wrap.className = 'border border-gray-200 rounded-lg px-3 py-3 bg-white shadow-sm';

	const lowEnd = parseScaleEntry(entries[0]);
	const highEnd = parseScaleEntry(entries[10]);

	// Anchor labels row: low-end label left, high-end label right.
	const labels = document.createElement('div');
	labels.className = 'flex justify-between gap-2 mb-2';
	const low = document.createElement('span');
	low.className = 'text-xs text-gray-500 leading-tight max-w-[45%]';
	low.textContent = lowEnd.label || lowEnd.num;
	const high = document.createElement('span');
	high.className = 'text-xs text-gray-500 leading-tight max-w-[45%] text-right';
	high.textContent = highEnd.label || highEnd.num;
	labels.appendChild(low);
	labels.appendChild(high);
	wrap.appendChild(labels);

	// Numbers row: all 11 cells, equal width, no wrapping. Endpoints emphasized.
	const row = document.createElement('div');
	row.className = 'flex items-stretch gap-0.5';
	for (let i = 0; i < entries.length; i++) {
		const { num } = parseScaleEntry(entries[i]);
		const cell = document.createElement('div');
		const isEnd = i === 0 || i === entries.length - 1;
		cell.className = 'flex-1 min-w-0 text-center py-1.5 rounded text-sm font-medium border '
			+ (isEnd
				? 'border-orange-300 bg-orange-50 text-orange-700'
				: 'border-gray-200 bg-gray-50 text-gray-700');
		cell.textContent = num;
		row.appendChild(cell);
	}
	wrap.appendChild(row);

	return wrap;
}

function isNumericScale(entries) {
	if (entries.length !== 11) return false;
	for (let i = 0; i < entries.length; i++) {
		if (!entries[i].trimStart().startsWith(String(i))) return false;
	}
	return true;
}

function filterText(text) {
	const idx = text.indexOf('\n');
	return idx >= 0 ? text.slice(0, idx) : text;
}

function clearRetrySchedule() {
	for (const t of retryTimers) clearTimeout(t);
	retryTimers = [];
}

// Arm the retransmission schedule for the batch that was just transmitted for
// the first time. Each timer re-checks that it is still the current, still
// unacknowledged batch before firing, so a newer question or an arriving ack
// silently cancels the rest.
function scheduleRetries(batch) {
	clearRetrySchedule();
	for (const delay of RETRY_DELAYS_MS) {
		retryTimers.push(setTimeout(() => {
			if (currentBatch !== batch || batch.acked) return;
			console.warn('[ANSWER-OPTIONS] no ack for seq=', batch.seq, 'after', delay, 'ms — retransmitting');
			deliverCurrentBatch('retry');
		}, delay));
	}
}

function startHeartbeat() {
	if (heartbeatTimer) return;
	heartbeatTimer = setInterval(() => {
		if (!currentBatch) return;
		deliverCurrentBatch('heartbeat');
	}, HEARTBEAT_MS);
}

// Transmit the current batch. Safe to call repeatedly: the receiver drops any
// revision it has already rendered, so retries, the heartbeat and rejoin
// re-pushes are all the same operation.
function deliverCurrentBatch(why) {
	const batch = currentBatch;
	if (!batch) return false;
	if (!state.textHandle || !state.chatReady) {
		console.debug('[ANSWER-OPTIONS] channel not ready — deferring seq=', batch.seq, '(', why, ')');
		return false;
	}

	// Register with the ack tracker on the FIRST real transmission rather than
	// when the batch was composed. Otherwise the ack budget would burn down while
	// the data channel was still connecting and report a failure for something we
	// had not even attempted to send yet.
	if (!batch.tracked) {
		batch.tracked = true;
		batch.msgId = getAckTracker().track({ label: batch.ackLabel, count: batch.ackCount });
		if (!batch.silentLocal) {
			appendLocalAnswerOptions(batch.msgId, batch.lines, {
				kind: batch.suppressedBy ? 'suppressed' : 'options',
				note: batch.suppressedBy
			});
		}
		scheduleRetries(batch);
	}

	const payload = {
		kind: 'answer_options',
		msgId: batch.msgId,
		epoch: ANSWER_EPOCH,
		seq: batch.seq,
		data: batch.data
	};
	console.debug('[ANSWER-OPTIONS] sending seq=', batch.seq, 'msgId=', batch.msgId,
		'reason=', why, 'suppressedBy=', batch.suppressedBy || '(none)');

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
			error: (reason) => {
				// Note: janus.js reports success even for a message merely queued on
				// a closed channel, so this rarely fires. The ack timeout and the
				// heartbeat are the real safety nets, not this callback.
				console.error('[ANSWER-OPTIONS] send error:', reason);
			}
		});
		state.pendingAnswerOptions = null;
		return true;
	} catch (e) {
		console.error('[ANSWER-OPTIONS] send threw', e && e.message);
		return false;
	}
}

export function sendAnswerOptions(data, opts) {
	if (!IS_INTERVIEWER) return;
	// Kept for the diagnostic report: the batch composed but not yet transmitted.
	state.pendingAnswerOptions = data;

	// Apply the SAME filter the interviewee uses, so the interviewer's echo shows
	// exactly what will appear on the participant's screen. When the filter
	// suppresses everything we still send — their panel has to switch to the
	// free-answer note — but we label the echo as suppressed and say which rule
	// did it, so "deliberately hidden" can never be mistaken for "never arrived".
	const displayable = getDisplayableOptions(data);
	const hasConcrete = Array.isArray(displayable) && displayable.length > 0;
	const suppressedBy = hasConcrete ? null : describeSuppression(data);
	const summary = hasConcrete ? summarizeBatch(displayable) : null;

	const batch = {
		seq: ++answerSeq,
		data,
		msgId: null,
		tracked: false,
		acked: false,
		suppressedBy,
		lines: hasConcrete ? answerOptionLines(displayable) : ['Freie Antwort — ' + suppressedBy],
		ackLabel: hasConcrete ? summary.label : ('Freie Antwort (' + suppressedBy + ')'),
		ackCount: hasConcrete ? summary.count : 0,
		silentLocal: !!(opts && opts.silentLocal)
	};

	currentBatch = batch;
	clearRetrySchedule();
	deliverCurrentBatch('initial');
	startHeartbeat();
}

// Called on the INTERVIEWER side when an ack message arrives from the interviewee.
export function handleAnswerAck(ackOf) {
	if (!IS_INTERVIEWER || !ackOf) return;
	if (currentBatch && currentBatch.msgId === ackOf) {
		currentBatch.acked = true;
		clearRetrySchedule();
	}
	getAckTracker().ack(ackOf);
}

// Re-deliver whatever the participant should currently be seeing. Called when
// the interviewee (re)joins the chat and when our own channel reconnects, so a
// participant who reloaded — or who was unreachable while the batch was first
// sent — still ends up with the current categories.
//
// This re-sends the SAME revision and msgId rather than creating a new batch:
// the participant's revision guard makes it a no-op if they already have it,
// and the interviewer's ack chip doesn't gain a duplicate entry.
export function repushLatestAnswerOptions() {
	if (!IS_INTERVIEWER || !currentBatch) return;
	deliverCurrentBatch('rejoin');
}

// Build the ack payload the INTERVIEWEE sends back after rendering a batch.
export function buildAnswerAck(msgId) {
	return { kind: 'ack', ackOf: msgId, status: 'received' };
}

export function setupAnswerOptionListener() {
	if (!IS_INTERVIEWER) return;
	const iframe = document.getElementById('questionnaire-iframe');

	// Derive the trusted origin from the iframe's own base URL, so the allowlist
	// can never drift from the page actually being embedded. Extra origins can
	// still be added through ANSWER_OPTIONS_ALLOWED_ORIGINS.
	const allowed = ANSWER_OPTIONS_ALLOWED_ORIGINS.slice();
	const baseUrl = iframe && iframe.getAttribute('data-base-url');
	if (baseUrl) {
		try {
			allowed.push(new URL(baseUrl, window.location.href).origin);
		} catch (e) {
			console.warn('[ANSWER-OPTIONS] could not derive origin from data-base-url:', baseUrl);
		}
	}

	const accept = (source, origin, data) => {
		if (iframe && source && source !== iframe.contentWindow) return;
		if (allowed.length && !allowed.includes(origin)) {
			// Enforced, but LOUDLY. Turning this check on introduces a new way for
			// answer options to stop arriving — if the questionnaire ever redirects
			// to another host, every batch would be rejected. Silent rejection is
			// exactly the failure mode we are trying to eliminate, so this shouts
			// on the console (captured in the diagnostic report) and tells the
			// interviewer directly instead of just dropping the message.
			console.error('[ANSWER-OPTIONS] REJECTED label_listing from unexpected origin', origin,
				'— allowed:', allowed.join(', '),
				'| If the questionnaire moved to a new host, add it to ANSWER_OPTIONS_ALLOWED_ORIGINS in js/state.js.');
			if (typeof toastr !== 'undefined' && toastr) {
				toastr.error('Antwortoptionen von unerwarteter Quelle (' + origin + ') abgelehnt.');
			}
			return;
		}
		sendAnswerOptions(data);
	};

	window.addEventListener('message', (event) => {
		const payload = event && event.data;
		if (!payload || payload.event !== 'label_listing' || !payload.data) return;
		accept(event.source, event.origin, payload.data);
	});

	// Drain anything the questionnaire posted before this module was ready.
	// interviewer.html sets iframe.src synchronously while parsing, but this
	// listener only exists after DOMContentLoaded → loadIncludes() → here; an
	// early post would otherwise be dropped with no trace at all. The inline
	// buffer in interviewer.html holds them until now.
	const buffered = window.__facesLabelListingBuffer;
	window.__facesLabelListingBuffer = null; // signals the inline buffer to stop
	if (Array.isArray(buffered) && buffered.length) {
		console.debug('[ANSWER-OPTIONS] draining', buffered.length, 'buffered label_listing message(s)');
		for (const item of buffered) accept(item.source, item.origin, item.data);
	}
}
