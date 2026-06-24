// Paints whatever the main process sends. No Node access here — just DOM + the `window.ram`
// bridge from preload.js.

const $ = (id) => document.getElementById(id);
const colorFor = (p) => (p >= 88 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)');

// Build one process row with DOM nodes (textContent), never innerHTML — a process can be
// named anything, so we treat every name as plain text and there's no markup to inject.
function procRow(p) {
	const row = document.createElement('div'); row.className = 'row';
	const meta = document.createElement('div'); meta.className = 'meta';
	const name = document.createElement('div'); name.className = 'dir'; name.textContent = p.name;
	const det = document.createElement('div'); det.className = 'det';
	det.textContent = (p.rssMb != null ? p.rssMb.toFixed(0) : '?') + ' MB';
	meta.append(name, det);
	const acts = document.createElement('div'); acts.className = 'acts';
	const btn = document.createElement('button'); btn.className = 'free'; btn.textContent = 'Quit';
	btn.dataset.pid = String(p.pid); btn.dataset.name = p.name;
	acts.append(btn);
	row.append(meta, acts);
	return row;
}

function render(d) {
	const ram = d.ram || {};
	const pct = typeof ram.usedPct === 'number' ? ram.usedPct : 0;
	$('ramFill').style.width = Math.min(100, pct) + '%';
	$('ramFill').style.background = colorFor(pct);
	$('ramTxt').textContent =
		(ram.usedGb != null ? ram.usedGb.toFixed(1) : '?') + ' / ' +
		(ram.totalGb != null ? ram.totalGb.toFixed(0) : '?') + ' GB (' + pct.toFixed(0) + '%)';

	const totalGb = ram.totalGb || 0;
	const compPct = totalGb ? ((ram.compressorMb || 0) / (totalGb * 1024)) * 100 : 0;
	$('compFill').style.width = Math.min(100, compPct) + '%';
	$('compFill').style.background = compPct >= 30 ? 'var(--red)' : 'var(--gold)';
	$('compTxt').textContent = (ram.compressorMb != null ? ram.compressorMb.toFixed(0) : '?') + ' MB (' + compPct.toFixed(0) + '%)';

	const procs = d.procs || [];
	const host = $('procs');
	host.replaceChildren();
	if (!procs.length) {
		const empty = document.createElement('div'); empty.className = 'empty';
		empty.textContent = 'No user apps found.';
		host.append(empty);
	} else {
		for (const p of procs) { host.append(procRow(p)); }
	}
}

document.addEventListener('click', (e) => {
	const b = e.target.closest('button.free');
	if (!b) { return; }
	window.ram.quit(Number(b.dataset.pid), b.dataset.name);
});

window.ram.onData(render);
