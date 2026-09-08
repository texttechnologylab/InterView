export function escapeHtml(value) {
	if (value === undefined || value === null) return '';
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function nowTime() {
	const d = new Date();
	const pad = (n) => ("0" + n).slice(-2);
	return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
