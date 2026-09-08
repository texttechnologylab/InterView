/*
 * answer-ack-indicator.js — the VIEW layer for answer-option acknowledgements.
 *
 * This is the only DOM-specific piece of the ack feature. It renders a header
 * chip ("Gesendet ✓ N") plus a hover/click dropdown listing each sent batch and
 * its status. It subscribes to AckTracker state purely through notifyAnswerAck()
 * — it never reaches into the tracker or the wire. In Unity you replace THIS file
 * with a MonoBehaviour that subscribes to AckTracker.Changed and updates a
 * uGUI/TextMeshPro chip; the tracker and protocol layers stay identical.
 *
 * Status → visual mapping:
 *     acked   → green checkmark
 *     pending → grey spinner-ish dot
 *     failed  → amber warning triangle
 */

import { ACK_STATUS } from './ack-tracker.js';

let chipEl = null;        // the whole chip container
let countEl = null;       // the number
let iconEl = null;        // the leading status icon
let dropdownEl = null;    // the details list
let pulseTimer = null;    // clears the "new" emphasis after a moment
let onClearNewFlags = null; // callback to tell the tracker to drop isNew flags

// Called by setupAnswerAckIndicator (interviewer only). Wires the tracker's
// clearNewFlags so we can stop emphasis after animating.
export function setAnswerAckClearer(fn) {
	onClearNewFlags = fn;
}

export function setupAnswerAckIndicator() {
	chipEl = document.getElementById('answer-ack-chip');
	if (!chipEl) return; // interviewee page has no chip — nothing to wire
	countEl = chipEl.querySelector('#answer-ack-count');
	iconEl = chipEl.querySelector('#answer-ack-icon');
	dropdownEl = document.getElementById('answer-ack-dropdown');

	// Toggle dropdown on click; also show on hover via CSS (group-hover handled
	// in markup). Click toggle helps touch/precision users.
	chipEl.addEventListener('click', (e) => {
		e.stopPropagation();
		if (!dropdownEl) return;
		dropdownEl.classList.toggle('hide');
	});
	document.addEventListener('click', () => {
		if (dropdownEl) dropdownEl.classList.add('hide');
	});
}

// Entry point the tracker calls on every change. `entries` is the full ordered
// list of tracked batches (oldest first).
export function notifyAnswerAck(entries) {
	if (!chipEl) return; // indicator not present (non-interviewer)

	const counts = entries.reduce((acc, e) => {
		acc.total++;
		if (e.status === ACK_STATUS.ACKED) acc.acked++;
		else if (e.status === ACK_STATUS.FAILED) acc.failed++;
		else acc.pending++;
		return acc;
	}, { total: 0, acked: 0, pending: 0, failed: 0 });

	// Reveal the chip once anything has been sent.
	chipEl.classList.toggle('hide', counts.total === 0);

	// Count shows acked / total so the interviewer sees confirmed vs sent.
	if (countEl) countEl.textContent = counts.acked + '/' + counts.total;

	// The ICON reflects the status of the MOST RECENT batch only, so the
	// interviewer can always tell whether the latest send went through —
	// independent of any earlier failures.
	const latest = entries.length ? entries[entries.length - 1] : null;
	if (iconEl && latest) {
		iconEl.className = 'fas ' + (
			latest.status === ACK_STATUS.FAILED ? 'fa-triangle-exclamation'
				: latest.status === ACK_STATUS.PENDING ? 'fa-circle-notch fa-spin'
					: 'fa-circle-check'
		);
	}

	// The PILL turns orange (persistent) if ANY batch ever failed — a lasting
	// "something went wrong at some point" signal — while the icon above stays
	// fresh for the latest batch. The icon color follows the pill state so it
	// stays legible on whichever background is showing.
	const hadFailure = counts.failed > 0;
	chipEl.classList.toggle('answer-ack-chip--error', hadFailure);
	if (iconEl) {
		// On the orange pill, icons read white-ish; otherwise use status colors.
		if (hadFailure) {
			iconEl.classList.remove('text-green-600', 'text-gray-400', 'text-amber-600');
			iconEl.classList.add('text-white');
		} else {
			iconEl.classList.remove('text-white', 'text-amber-600');
			iconEl.classList.toggle('text-green-600', latest && latest.status === ACK_STATUS.ACKED);
			iconEl.classList.toggle('text-gray-400', latest && latest.status === ACK_STATUS.PENDING);
		}
	}

	// Emphasis pulse when something just changed (new send or fresh ack).
	const hasNew = entries.some((e) => e.isNew);
	if (hasNew) {
		chipEl.classList.add('answer-ack-pulse');
		if (pulseTimer) clearTimeout(pulseTimer);
		pulseTimer = setTimeout(() => {
			chipEl.classList.remove('answer-ack-pulse');
			if (onClearNewFlags) onClearNewFlags();
		}, 1500);
	}

	renderDropdown(entries);
}

function renderDropdown(entries) {
	if (!dropdownEl) return;
	if (!entries.length) {
		dropdownEl.innerHTML = '<div class="px-3 py-2 text-xs text-gray-400">Noch nichts gesendet.</div>';
		return;
	}
	// Newest first in the list for quick scanning.
	const rows = entries.slice().reverse().map((e) => {
		const icon = e.status === ACK_STATUS.ACKED
			? '<i class="fas fa-circle-check text-green-600"></i>'
			: e.status === ACK_STATUS.FAILED
				? '<i class="fas fa-triangle-exclamation text-amber-600"></i>'
				: '<i class="fas fa-circle-notch fa-spin text-gray-400"></i>';
		const statusText = e.status === ACK_STATUS.ACKED
			? 'Empfangen'
			: e.status === ACK_STATUS.FAILED
				? 'Keine Bestätigung'
				: 'Gesendet…';
		const time = new Date(e.ackedAt || e.sentAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
		const label = escapeHtml(e.meta && e.meta.label ? e.meta.label : 'Antwortoptionen');
		const newCls = e.isNew ? ' bg-green-50' : '';
		return `
			<div class="flex items-start gap-2 px-3 py-2 border-b border-gray-100 last:border-0${newCls}">
				<span class="mt-0.5 shrink-0">${icon}</span>
				<div class="min-w-0">
					<div class="text-xs font-medium text-gray-700 truncate">${label}</div>
					<div class="text-[11px] text-gray-400">${statusText} · ${time}</div>
				</div>
			</div>`;
	}).join('');
	dropdownEl.innerHTML = rows;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
