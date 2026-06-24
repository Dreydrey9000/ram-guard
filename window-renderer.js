/*---------------------------------------------------------------------------------------------
 *  RAM Guard — full window renderer (sandboxed).
 *
 *  Promoted from design/mockup.html. The look is identical (bone+gold, 7 views, Smart Scan and
 *  Free-up animations), but EVERY mock data array is gone — the views are driven by REAL data
 *  pulled over the window.ram.* bridge, and every action button routes through window.ram.*
 *  which triggers a main-process confirm dialog before anything is moved to the Trash.
 *
 *  Security: no Node here (sandbox + contextIsolation). Rows are built with createElement /
 *  textContent — file names, app names and process names are NEVER injected as innerHTML, so a
 *  filename like `<img onerror=...>` is rendered as literal text, not parsed as markup. The only
 *  innerHTML used anywhere is for the fixed, constant SVG glyphs that carry no user data.
 *--------------------------------------------------------------------------------------------*/
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Constant SVG glyphs (no user data) — safe to set via innerHTML on a throwaway element.
  var GLYPH_APP = '<svg viewBox="0 0 24 24" fill="none" stroke="#a6864e" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>';
  var GLYPH_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="#a6864e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
  var GLYPH_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#c4a86f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  var GLYPH_WHITELIST = [GLYPH_APP, GLYPH_FILE, GLYPH_CHECK];
  function glyph(markup) {
    var span = document.createElement('span');
    span.style.display = 'contents';
    // Hard gate: only the three known-constant SVG strings are ever allowed through innerHTML.
    // Anything else (which should be impossible) renders as nothing, never as parsed markup.
    if (GLYPH_WHITELIST.indexOf(markup) !== -1) { span.innerHTML = markup; }
    return span;
  }

  // ---- formatting ----
  function fmtMb(mb) {
    if (mb >= 1024) { return (mb / 1024).toFixed(1) + ' GB'; }
    return Math.round(mb) + ' MB';
  }
  function fmtBytes(bytes) {
    return fmtMb(bytes / 1024 / 1024);
  }
  function fmtAge(days) {
    if (days >= 365) { return (days / 365).toFixed(days >= 730 ? 0 : 1) + ' years ago'; }
    if (days >= 60) { return Math.round(days / 30) + ' months ago'; }
    if (days >= 30) { return 'about a month ago'; }
    return days + ' days ago';
  }

  // ---- generic row builder (DOM nodes + textContent, NEVER innerHTML of names) ----
  // opts: { title, sub, right (string|null), glyphMarkup, action, danger, data:{} }
  function buildRow(opts) {
    var li = document.createElement('div');
    li.className = 'li';
    if (opts.data) {
      Object.keys(opts.data).forEach(function (k) { li.dataset[k] = String(opts.data[k]); });
    }

    var ico = document.createElement('div');
    ico.className = 'ico';
    ico.appendChild(glyph(opts.glyphMarkup || GLYPH_FILE));
    li.appendChild(ico);

    var nm = document.createElement('div');
    nm.className = 'nm';
    var b = document.createElement('b');
    b.textContent = opts.title;          // <-- user data as TEXT, not markup
    nm.appendChild(b);
    if (opts.sub) {
      var small = document.createElement('small');
      small.textContent = opts.sub;      // <-- user data as TEXT
      nm.appendChild(small);
    }
    li.appendChild(nm);

    if (opts.right != null) {
      var mb = document.createElement('div');
      mb.className = 'mb';
      mb.textContent = opts.right;
      li.appendChild(mb);
    }

    if (opts.action) {
      var btn = document.createElement('button');
      btn.className = 'act' + (opts.danger ? ' danger' : '');
      btn.textContent = opts.action;
      btn.dataset.action = opts.action.toLowerCase();
      li.appendChild(btn);
    }
    return li;
  }

  // a row whose right edge is a toggle (login items + junk categories)
  function buildToggleRow(opts) {
    var li = document.createElement('div');
    li.className = 'li';
    if (opts.data) {
      Object.keys(opts.data).forEach(function (k) { li.dataset[k] = String(opts.data[k]); });
    }
    var ico = document.createElement('div');
    ico.className = 'ico';
    ico.appendChild(glyph(opts.glyphMarkup || GLYPH_APP));
    li.appendChild(ico);

    var nm = document.createElement('div');
    nm.className = 'nm';
    var b = document.createElement('b');
    b.textContent = opts.title;
    nm.appendChild(b);
    if (opts.sub) {
      var small = document.createElement('small');
      small.textContent = opts.sub;
      nm.appendChild(small);
    }
    li.appendChild(nm);

    if (opts.right != null) {
      var mb = document.createElement('div');
      mb.className = 'mb';
      mb.textContent = opts.right;
      li.appendChild(mb);
    }

    var tg = document.createElement('div');
    tg.className = 'tg' + (opts.on ? ' on' : '');
    tg.dataset[opts.toggleKind] = '1';
    li.appendChild(tg);
    return li;
  }

  function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }
  function emptyMsg(text) {
    var d = document.createElement('div');
    d.className = 'empty';
    d.textContent = text;
    return d;
  }

  // ---- toast ----
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.appendChild(glyph(GLYPH_CHECK));
    var span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    $('#toasts').appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  // remove a row with the slide-out animation
  function removeRow(li) {
    li.style.height = li.offsetHeight + 'px';
    requestAnimationFrame(function () { li.classList.add('removing'); });
    setTimeout(function () { li.remove(); }, 360);
  }

  // =============================================================================================
  //  LIVE MEMORY (pushed every tick) — Overview ring/tiles + Memory view + process lists
  // =============================================================================================
  var lastRam = null;
  var lastProcs = [];

  function pctClass(pct) { return pct >= 88 ? 'crit' : pct >= 75 ? 'warn' : ''; }

  function renderMemory() {
    if (!lastRam) { return; }
    var pct = Math.round(lastRam.usedPct);

    // sidebar badge
    $('#navMem').textContent = pct + '%';

    // Overview tile
    $('#tMem').textContent = pct + '%';
    var b = $('#tMemBar'); b.style.width = pct + '%'; b.className = pctClass(pct);
    $('#tApps').textContent = String(lastProcs.length);
    $('#tAppsBar').style.width = Math.min(100, lastProcs.length * 5) + '%';

    // health ring (health = inverse of used) + meta
    updateRing(pct);
    $('#ovMeta').textContent = 'Memory ' + pct + '% · ' + lastProcs.length + ' apps tracked';

    // Memory view tiles
    $('#m2used').textContent = pct + '%';
    var mb = $('#m2bar'); mb.style.width = pct + '%'; mb.className = pctClass(pct);
    var comp = lastRam.compressorMb || 0;
    $('#m2comp').textContent = fmtMb(comp);
    // scale compression bar against ~25% of total RAM as a rough "high pressure" ceiling
    var totalMb = (lastRam.totalGb || 1) * 1024;
    $('#m2compbar').style.width = Math.min(100, (comp / (totalMb * 0.25)) * 100) + '%';
    $('#memMeta').textContent = (lastRam.totalGb ? lastRam.totalGb.toFixed(0) + ' GB total · ' : '') + 'updates live';

    // process lists (Overview + Memory) — quitting frees RAM
    renderProcList($('#memList'));
    renderProcList($('#memList2'));

    var reclaim = lastProcs.reduce(function (s, p) { return s + p.rssMb; }, 0);
    $('#memReclaim').textContent = fmtMb(reclaim);
  }

  function renderProcList(container) {
    if (!container) { return; }
    clear(container);
    if (!lastProcs.length) { container.appendChild(emptyMsg('No heavy apps right now.')); return; }
    lastProcs.forEach(function (p) {
      var sub = '';
      var row = buildRow({
        title: p.name,
        sub: sub,
        right: fmtMb(p.rssMb),
        glyphMarkup: GLYPH_APP,
        action: 'Quit',
        danger: true,
        data: { mb: Math.round(p.rssMb), pid: p.pid, name: p.name, kind: 'quit' }
      });
      container.appendChild(row);
    });
  }

  function updateRing(used) {
    var health = Math.max(8, Math.min(96, 100 - used + 8));
    var dash = 170;
    var off = dash * (1 - health / 100);
    var arc = $('#ringArc');
    arc.style.strokeDashoffset = off;
    arc.setAttribute('stroke', health > 70 ? '#3FA66B' : health > 45 ? '#C2A878' : '#E0556F');
    $('#ringPct').textContent = Math.round(health);
    // Banner must agree with the ring: tier the message off how much memory is USED, so a low
    // ring score can never read "running clean". >=75% used = attention, 46-74% = tidier, <=45% = clean.
    if (used >= 75) {
      $('#healthTitle').textContent = 'Your Mac needs attention';
      $('#healthSub').textContent = used + '% memory used · quit a few heavy apps to free RAM';
    } else if (used >= 46) {
      $('#healthTitle').textContent = 'Your Mac could be tidier';
      $('#healthSub').textContent = used + '% memory used · quitting an app or two would help';
    } else {
      $('#healthTitle').textContent = 'Your Mac is running clean';
      $('#healthSub').textContent = used + '% memory used · you are in good shape';
    }
  }

  // =============================================================================================
  //  STORAGE — stacked bar + legend + Overview Storage tile
  // =============================================================================================
  function renderStorage(info) {
    var stack = $('#storeStack');
    var legend = $('#storeLegend');
    clear(stack); clear(legend);
    var total = info.totalGb || 1;
    info.categories.forEach(function (c) {
      var seg = document.createElement('i');
      seg.style.width = Math.max(0, (c.gb / total) * 100) + '%';
      seg.style.background = c.color;
      stack.appendChild(seg);

      var rowEl = document.createElement('div');
      rowEl.className = 'row';
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = c.color;
      if (c.key === 'free') { dot.style.border = '1px solid #d8d0bd'; }
      rowEl.appendChild(dot);
      var label = document.createTextNode(' ' + c.label + ' ');
      rowEl.appendChild(label);
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = c.gb.toFixed(0) + ' GB';
      rowEl.appendChild(v);
      legend.appendChild(rowEl);
    });
    $('#storeMeta').textContent = info.usedGb.toFixed(0) + ' GB of ' + info.totalGb.toFixed(0) + ' GB used';

    // Overview Storage tile
    $('#tStore').textContent = info.usedGb.toFixed(0);
    var small = document.createElement('small');
    small.textContent = '/' + info.totalGb.toFixed(0) + ' GB';
    $('#tStore').appendChild(small);
    var pct = Math.round(info.usedPct);
    var sb = $('#tStoreBar'); sb.style.width = pct + '%'; sb.className = pctClass(pct);
  }

  // =============================================================================================
  //  JUNK — categories with toggles + total + Overview "Reclaim space"
  // =============================================================================================
  var junkCats = [];

  function renderJunk(cats) {
    junkCats = cats || [];
    var list = $('#junkList');
    clear(list);
    if (!junkCats.length) { list.appendChild(emptyMsg('Nothing to clean right now.')); }
    junkCats.forEach(function (c) {
      var row = buildToggleRow({
        title: c.label,
        sub: c.detail,
        right: fmtMb(c.mb),
        glyphMarkup: GLYPH_FILE,
        on: c.selected,
        toggleKind: 'junktoggle',
        data: { mb: Math.round(c.mb), key: c.key }
      });
      list.appendChild(row);
    });
    recalcJunk();

    var totalMb = junkCats.reduce(function (s, c) { return s + c.mb; }, 0);
    $('#navJunk').textContent = fmtMb(totalMb);
    $('#tJunk').textContent = fmtMb(totalMb);
    // scale the junk tile bar against ~20 GB as a rough "lots of junk" ceiling
    $('#tJunkBar').style.width = Math.min(100, (totalMb / (20 * 1024)) * 100) + '%';

    // Overview "Reclaim space" — show each junk category as a removable line
    var space = $('#spaceList');
    clear(space);
    if (!junkCats.length) { space.appendChild(emptyMsg('Nothing to reclaim.')); }
    junkCats.forEach(function (c) {
      var row = buildRow({
        title: c.label,
        sub: c.detail,
        right: fmtMb(c.mb),
        glyphMarkup: GLYPH_FILE,
        action: 'Clean',
        danger: false,
        data: { mb: Math.round(c.mb), key: c.key, kind: 'cleanone' }
      });
      space.appendChild(row);
    });
  }

  function recalcJunk() {
    var sum = 0;
    $$('#junkList .li').forEach(function (li) {
      var tg = $('.tg', li);
      if (tg && tg.classList.contains('on')) { sum += Number(li.dataset.mb || 0); }
    });
    $('#junkTotal').textContent = fmtMb(sum);
  }

  function selectedJunkKeys() {
    var keys = [];
    $$('#junkList .li').forEach(function (li) {
      var tg = $('.tg', li);
      if (tg && tg.classList.contains('on') && li.dataset.key) { keys.push(li.dataset.key); }
    });
    return keys;
  }

  // =============================================================================================
  //  LARGE & OLD FILES
  // =============================================================================================
  function renderLarge(files) {
    var list = $('#largeList');
    clear(list);
    if (!files || !files.length) { list.appendChild(emptyMsg('No large, untouched files found in your common folders.')); return; }
    files.forEach(function (f) {
      var sub = f.category + ' · ' + fmtAge(f.ageDays);
      var row = buildRow({
        title: f.name,
        sub: sub,
        right: fmtMb(f.mb),
        glyphMarkup: GLYPH_FILE,
        action: 'Reveal',
        danger: false,
        data: { mb: Math.round(f.mb), path: f.path, kind: 'reveal' }
      });
      // add a second, danger Trash action alongside Reveal
      var trashBtn = document.createElement('button');
      trashBtn.className = 'act danger';
      trashBtn.textContent = 'Trash';
      trashBtn.dataset.action = 'trash';
      trashBtn.style.marginLeft = '8px';
      row.appendChild(trashBtn);
      list.appendChild(row);
    });
  }

  // =============================================================================================
  //  APPLICATIONS
  // =============================================================================================
  function renderApps(apps) {
    var list = $('#appsList');
    clear(list);
    if (!apps || !apps.length) { list.appendChild(emptyMsg('No third-party apps found to manage.')); }
    (apps || []).forEach(function (a) {
      var row = buildRow({
        title: a.name,
        sub: a.detail,
        right: fmtMb(a.mb),
        glyphMarkup: GLYPH_APP,
        action: 'Uninstall',
        danger: true,
        data: { mb: Math.round(a.mb), path: a.path, kind: 'uninstall' }
      });
      list.appendChild(row);
    });
    $('#appsMeta').textContent = (apps ? apps.length : 0) + ' installed · uninstall fully — leftovers and all, to Trash';
  }

  // =============================================================================================
  //  LOGIN ITEMS
  // =============================================================================================
  function renderLogin(items) {
    var list = $('#loginList');
    clear(list);
    if (!items || !items.length) { list.appendChild(emptyMsg('No login items found.')); return; }
    items.forEach(function (it) {
      var row = buildToggleRow({
        title: it.name,
        sub: it.hidden ? 'opens hidden in the background' : 'opens at login',
        right: null,
        glyphMarkup: GLYPH_APP,
        on: it.enabled,
        toggleKind: 'logintoggle',
        data: { name: it.name }
      });
      list.appendChild(row);
    });
  }

  // =============================================================================================
  //  DATA LOADING (lazy per view; Overview pulls everything once)
  // =============================================================================================
  var loaded = { storage: false, junk: false, large: false, apps: false, login: false };

  function loadStorage(force) {
    if (loaded.storage && !force) { return Promise.resolve(); }
    return window.ram.getStorage().then(function (info) { loaded.storage = true; renderStorage(info); })
      .catch(function () { /* engine degrades gracefully */ });
  }
  function loadJunk(force) {
    if (loaded.junk && !force) { return Promise.resolve(); }
    return window.ram.scanJunk().then(function (cats) { loaded.junk = true; renderJunk(cats); })
      .catch(function () { });
  }
  function loadLarge(force) {
    if (loaded.large && !force) { return Promise.resolve(); }
    $('#largeList').firstChild && ($('#largeList').textContent = '');
    clear($('#largeList')); $('#largeList').appendChild(emptyMsg('Scanning your folders…'));
    return window.ram.scanLarge().then(function (files) { loaded.large = true; renderLarge(files); })
      .catch(function () { clear($('#largeList')); $('#largeList').appendChild(emptyMsg('Could not scan right now.')); });
  }
  function loadApps(force) {
    if (loaded.apps && !force) { return Promise.resolve(); }
    clear($('#appsList')); $('#appsList').appendChild(emptyMsg('Reading installed apps…'));
    return window.ram.listApps().then(function (apps) { loaded.apps = true; renderApps(apps); })
      .catch(function () { clear($('#appsList')); $('#appsList').appendChild(emptyMsg('Could not read apps right now.')); });
  }
  function loadLogin(force) {
    if (loaded.login && !force) { return Promise.resolve(); }
    return window.ram.listLogin().then(function (items) { loaded.login = true; renderLogin(items); })
      .catch(function () { });
  }

  function loadForView(v) {
    if (v === 'storage') { loadStorage(); }
    else if (v === 'junk') { loadJunk(); }
    else if (v === 'large') { loadLarge(); }
    else if (v === 'apps') { loadApps(); }
    else if (v === 'login') { loadLogin(); }
    else if (v === 'overview') { loadStorage(); loadJunk(); }
  }

  // =============================================================================================
  //  NAV
  // =============================================================================================
  $('#nav').addEventListener('click', function (e) {
    var it = e.target.closest('.navitem'); if (!it) { return; }
    $$('.navitem').forEach(function (n) { n.classList.remove('on'); });
    it.classList.add('on');
    showView(it.dataset.view);
  });
  function showView(v) {
    $('#scanwrap').classList.remove('on');
    $$('.view').forEach(function (x) { x.classList.remove('on'); });
    var el = document.getElementById(v); if (el) { el.classList.add('on'); }
    $('#main').scrollTop = 0;
    loadForView(v);
  }

  // =============================================================================================
  //  ACTIONS — every destructive button goes through window.ram.* which opens a main-process
  //  confirm dialog FIRST. The row only animates away AFTER the action resolves ok.
  // =============================================================================================
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.act'); if (!btn) { return; }
    var li = btn.closest('.li'); if (!li) { return; }
    var action = btn.dataset.action;
    var mb = Number(li.dataset.mb || 0);

    if (action === 'quit') {
      var pid = Number(li.dataset.pid);
      var pname = li.dataset.name || 'this app';
      window.ram.quit(pid, pname).then(function (r) {
        if (r && r.ok) { removeRow(li); toast('Quit ' + pname + ' — freed ' + fmtMb(mb)); }
      });
      return;
    }
    if (action === 'reveal') {
      window.ram.revealFile(li.dataset.path).then(function () { toast('Revealed in Finder'); });
      return;
    }
    if (action === 'trash') {
      window.ram.trashLarge(li.dataset.path).then(function (r) {
        if (r && r.ok) { removeRow(li); toast('Moved to Trash — freed ' + fmtMb(mb)); }
      });
      return;
    }
    if (action === 'uninstall') {
      window.ram.uninstallApp(li.dataset.path).then(function (r) {
        if (r && r.ok) { removeRow(li); toast('Uninstalled to Trash — freed ' + fmtBytes(r.freedBytes)); }
      });
      return;
    }
    if (action === 'clean') {
      // single junk category from the Overview "Reclaim space" list
      var key = li.dataset.key;
      window.ram.cleanJunk([key]).then(function (r) {
        if (r && r.ok) {
          removeRow(li);
          toast('Cleaned — moved ' + fmtBytes(r.freedBytes) + ' to Trash');
          loadJunk(true); // refresh the Junk view + totals
        }
      });
      return;
    }
  });

  // toggles (junk select + login enable/disable)
  document.addEventListener('click', function (e) {
    var jt = e.target.closest('[data-junktoggle]');
    if (jt) { jt.classList.toggle('on'); recalcJunk(); return; }

    var lt = e.target.closest('[data-logintoggle]');
    if (lt) {
      var li = lt.closest('.li');
      var name = li.dataset.name;
      var turningOn = !lt.classList.contains('on');
      // optimistic flip, revert if the user cancels the confirm
      window.ram.setLoginItem(name, turningOn).then(function (r) {
        if (r && r.ok) {
          lt.classList.toggle('on');
          toast(turningOn ? (name + ' will open at login') : (name + ' will no longer open at login'));
        }
      });
      return;
    }
  });

  // ---- Clean selected (Junk view) ----
  $('#cleanAll').addEventListener('click', function () {
    var keys = selectedJunkKeys();
    if (!keys.length) { toast('Select at least one category first'); return; }
    window.ram.cleanJunk(keys).then(function (r) {
      if (r && r.ok) {
        toast('Cleaned — moved ' + fmtBytes(r.freedBytes) + ' to Trash');
        loadJunk(true);
      }
    });
  });

  // ---- Free up now (Overview) — quit the top heavy app via the real confirm ----
  function freeUp() {
    if (!lastProcs.length) { toast('Nothing heavy to free right now'); return; }
    var top = lastProcs[0];
    window.ram.quit(top.pid, top.name).then(function (r) {
      if (r && r.ok) { toast('Freed ' + fmtMb(top.rssMb) + ' — quit ' + top.name); }
    });
  }
  $('#freeUp').addEventListener('click', freeUp);

  // =============================================================================================
  //  SMART SCAN — same animation, but it kicks off the REAL scans behind the progress bar
  // =============================================================================================
  var stages = ['Reading memory pressure', 'Hunting caches and logs', 'Finding large & old files', 'Checking installed apps'];
  $('#scanBtn').addEventListener('click', runScan);
  function runScan() {
    var btn = $('#scanBtn'); if (btn.classList.contains('spinning')) { return; }
    btn.classList.add('spinning');
    $$('.navitem').forEach(function (n) { n.classList.remove('on'); });
    $$('.view').forEach(function (x) { x.classList.remove('on'); });
    $('#scanwrap').classList.add('on');
    $$('.scancard').forEach(function (c) { c.classList.remove('done'); });

    // fire the real scans in parallel; the bar reflects progress as each resolves
    var results = ['—', '—', '—', '—'];
    if (lastRam) { results[0] = Math.round(lastRam.usedPct) + '%'; }

    var pJunk = window.ram.scanJunk().then(function (cats) {
      loaded.junk = true; renderJunk(cats);
      var totalMb = cats.reduce(function (s, c) { return s + c.mb; }, 0);
      results[1] = fmtMb(totalMb);
    }).catch(function () { results[1] = '0 MB'; });

    var pLarge = window.ram.scanLarge().then(function (files) {
      loaded.large = true; renderLarge(files);
      results[2] = (files ? files.length : 0) + ' files';
    }).catch(function () { results[2] = '0 files'; });

    var pApps = window.ram.listApps().then(function (apps) {
      loaded.apps = true; renderApps(apps);
      results[3] = (apps ? apps.length : 0) + ' apps';
    }).catch(function () { results[3] = '0 apps'; });

    void loadStorage(true); void loadLogin(true);

    var p = 0, step = 0;
    var fill = $('#scanFill'), stageEl = $('#scanStage');
    stageEl.textContent = stages[0]; fill.style.width = '0%';
    var t = setInterval(function () {
      p += 4; fill.style.width = p + '%';
      var ns = Math.min(3, Math.floor(p / 25));
      if (ns !== step) {
        step = ns; stageEl.textContent = stages[step];
        var card = $('.scancard[data-s="' + (step - 1) + '"]');
        if (card) { card.classList.add('done'); $('#sv' + (step - 1)).textContent = results[step - 1]; }
      }
      if (p >= 100) {
        clearInterval(t);
        Promise.all([pJunk, pLarge, pApps]).then(function () {
          $('.scancard[data-s="3"]').classList.add('done'); $('#sv3').textContent = results[3];
          // backfill any cards that finished after the bar
          for (var i = 0; i < 3; i++) { var c = $('.scancard[data-s="' + i + '"]'); if (c) { c.classList.add('done'); $('#sv' + i).textContent = results[i]; } }
          stageEl.textContent = 'Done — here is what we found';
          setTimeout(function () {
            btn.classList.remove('spinning');
            $('.navitem[data-view="overview"]').classList.add('on');
            showView('overview');
          }, 700);
        });
      }
    }, 55);
  }

  // =============================================================================================
  //  BOOT — subscribe to live memory, then pull the read scans the Overview needs
  // =============================================================================================
  window.ram.onData(function (d) {
    if (d && d.ram) { lastRam = d.ram; }
    if (d && d.procs) { lastProcs = d.procs; }
    renderMemory();
  });

  // initial read-only loads for the default (Overview) view
  loadStorage();
  loadJunk();
})();
