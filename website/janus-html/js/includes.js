export async function loadIncludes() {
	const nodes = Array.from(document.querySelectorAll('[data-include]'));
	if (!nodes.length) return;
	await Promise.all(nodes.map(async (node) => {
		const path = node.getAttribute('data-include');
		if (!path) return;
		const candidates = path.startsWith('dependencies/') ? [path] : [path, 'dependencies/' + path];
		try {
			for (const candidate of candidates) {
				const response = await fetch(candidate, { cache: 'default' });
				if (!response.ok) continue;
				const html = await response.text();
				node.outerHTML = html;
				return;
			}
			throw new Error('Include failed: ' + path);
		} catch (err) {
			console.error('Include load failed:', path, err);
		}
	}));
}
