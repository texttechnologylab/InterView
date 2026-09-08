/*
 * AckTracker — transport-agnostic request/acknowledgement correlation.
 *
 * This is the reusable core of the "did the other side receive it?" feature.
 * It has NO knowledge of Janus, the DOM, or answer options specifically. It
 * just tracks outbound messages by id and the acks that come back, exposing a
 * small state machine and a change-listener interface. The same design ports
 * directly to C#/Unity (see the porting notes at the bottom of this file).
 *
 * State machine per tracked message:
 *     pending  --(ack received)-->  acked
 *     pending  --(timeout elapsed)--> failed
 *     failed   --(late ack)-------->  acked   (recovers if the ack is just slow)
 *
 * Usage (sender side):
 *     const tracker = new AckTracker({ timeoutMs: 5000, onChange: render });
 *     const msgId = tracker.track({ label: 'Skala 0–10' });   // returns id
 *     // ...send your message over the wire including that msgId...
 *     // when an ack arrives:
 *     tracker.ack(msgIdFromAckMessage);
 *
 * The receiver side does not use this class; it just sends an ack message back
 * (see buildAck / kind:'ack' in answer-options.js).
 */

export const ACK_STATUS = Object.freeze({
	PENDING: 'pending',
	ACKED: 'acked',
	FAILED: 'failed'
});

let _idCounter = 0;
function defaultIdFactory(prefix) {
	_idCounter += 1;
	// Time + counter + randomness keeps ids unique across reloads and peers.
	return (prefix || 'msg') + '_' + Date.now().toString(36) + '_' + _idCounter.toString(36) +
		'_' + Math.random().toString(36).slice(2, 7);
}

export class AckTracker {
	/**
	 * @param {object} [opts]
	 * @param {number} [opts.timeoutMs=5000] ms before a pending entry becomes 'failed'. 0 disables.
	 * @param {(entries:Array)=>void} [opts.onChange] called whenever any entry's state changes.
	 * @param {string} [opts.idPrefix='msg'] prefix for generated message ids.
	 * @param {()=>string} [opts.idFactory] custom id generator (override for testing/Unity).
	 * @param {number} [opts.max=200] cap on retained entries (oldest evicted).
	 */
	constructor(opts = {}) {
		this.timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000;
		this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
		this.idPrefix = opts.idPrefix || 'msg';
		this.idFactory = opts.idFactory || (() => defaultIdFactory(this.idPrefix));
		this.max = opts.max || 200;
		// Insertion-ordered map: id -> entry. Map preserves order for the UI list.
		this._entries = new Map();
		this._timers = new Map();
	}

	/**
	 * Register a new outbound message. Returns the generated msgId, which the
	 * caller MUST include in the message it sends so the ack can be correlated.
	 * @param {object} [meta] arbitrary metadata to attach (e.g. { label, count }).
	 * @returns {string} msgId
	 */
	track(meta = {}) {
		const id = this.idFactory();
		const entry = {
			id,
			status: ACK_STATUS.PENDING,
			meta: meta || {},
			sentAt: Date.now(),
			ackedAt: null,
			isNew: true // transient flag for "just changed" UI emphasis
		};
		this._entries.set(id, entry);
		this._evictIfNeeded();
		if (this.timeoutMs > 0) {
			const t = setTimeout(() => this._onTimeout(id), this.timeoutMs);
			// Don't let the timer keep a Node process alive (harmless in browser).
			if (t && typeof t.unref === 'function') t.unref();
			this._timers.set(id, t);
		}
		this._emit();
		return id;
	}

	/**
	 * Mark a tracked message as acknowledged. No-op if the id is unknown (an ack
	 * for something we never tracked, or already evicted).
	 * @param {string} id the msgId echoed back by the receiver's ack.
	 * @returns {boolean} true if an entry was updated.
	 */
	ack(id) {
		const entry = this._entries.get(id);
		if (!entry) return false;
		if (entry.status === ACK_STATUS.ACKED) return false; // idempotent
		entry.status = ACK_STATUS.ACKED;
		entry.ackedAt = Date.now();
		entry.isNew = true;
		this._clearTimer(id);
		this._emit();
		return true;
	}

	/** Clear the transient "isNew" emphasis flag on every entry (after UI animates). */
	clearNewFlags() {
		let changed = false;
		for (const entry of this._entries.values()) {
			if (entry.isNew) { entry.isNew = false; changed = true; }
		}
		if (changed) this._emit();
	}

	/** @returns {Array} entries in send order (oldest first). Safe copies. */
	list() {
		return Array.from(this._entries.values(), (e) => ({ ...e, meta: { ...e.meta } }));
	}

	/** @returns {{total:number, pending:number, acked:number, failed:number}} */
	counts() {
		let pending = 0, acked = 0, failed = 0;
		for (const e of this._entries.values()) {
			if (e.status === ACK_STATUS.PENDING) pending++;
			else if (e.status === ACK_STATUS.ACKED) acked++;
			else if (e.status === ACK_STATUS.FAILED) failed++;
		}
		return { total: this._entries.size, pending, acked, failed };
	}

	/** Stop all timers (call on teardown). */
	dispose() {
		for (const t of this._timers.values()) clearTimeout(t);
		this._timers.clear();
		this._entries.clear();
	}

	// --- internals ---

	_onTimeout(id) {
		const entry = this._entries.get(id);
		this._clearTimer(id);
		if (!entry || entry.status !== ACK_STATUS.PENDING) return;
		entry.status = ACK_STATUS.FAILED;
		entry.isNew = true;
		this._emit();
	}

	_clearTimer(id) {
		const t = this._timers.get(id);
		if (t) { clearTimeout(t); this._timers.delete(id); }
	}

	_evictIfNeeded() {
		while (this._entries.size > this.max) {
			const oldestId = this._entries.keys().next().value;
			this._clearTimer(oldestId);
			this._entries.delete(oldestId);
		}
	}

	_emit() {
		try { this.onChange(this.list()); } catch (e) { /* listener must not break tracker */ }
	}
}

/*
 * ── C#/Unity porting notes ───────────────────────────────────────────────
 *
 * This class maps 1:1 to a C# class. Suggested shape:
 *
 *   public enum AckStatus { Pending, Acked, Failed }
 *
 *   public sealed class AckEntry {
 *       public string Id;
 *       public AckStatus Status;
 *       public Dictionary<string,object> Meta;
 *       public long SentAt;        // DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
 *       public long? AckedAt;
 *       public bool IsNew;
 *   }
 *
 *   public sealed class AckTracker {
 *       public event Action<IReadOnlyList<AckEntry>> Changed;
 *       public string Track(Dictionary<string,object> meta) { ... }
 *       public bool Ack(string id) { ... }
 *       public void ClearNewFlags() { ... }
 *       public IReadOnlyList<AckEntry> List() { ... }
 *       ...
 *   }
 *
 * - Use a Dictionary<string,AckEntry> + a List<string> for insertion order, or a
 *   plain List<AckEntry> (lookups are tiny). Map's ordering == insertion order.
 * - Replace setTimeout with: a CancellationTokenSource per entry +
 *   Task.Delay(timeoutMs, token), OR a single Update()/coroutine that scans for
 *   entries whose (now - SentAt) > timeoutMs while still Pending. The coroutine
 *   approach is the most Unity-idiomatic (no threads, runs on the main thread).
 * - Changed event replaces onChange; your MonoBehaviour subscribes and updates
 *   the indicator. Keep the tracker a plain C# class (not a MonoBehaviour) so it
 *   stays unit-testable and transport-independent — exactly as here.
 * - Id generation: $"{prefix}_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}_{Guid.NewGuid():N}".
 */
