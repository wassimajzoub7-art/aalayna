/* The onboarding page. Talks only to tools/onboard-ui.js on 127.0.0.1, with the token the
   tool put in this page's address (kept in memory, sent as X-Onboard-Token). Plain DOM,
   no framework; every text from the server goes in through textContent. */
(function () {
  'use strict';

  var TOKEN = new URLSearchParams(location.search).get('t') || '';
  var STEP_TITLES = { register: 'Register the venue', theme: 'Colours and font', menu: 'Menu', tables: 'Table codes and cards',
    staff: 'Staff list', verify: 'Live test', welcome: 'Welcome note' };
  var STATUS_WORDS = { pending: 'pending', running: 'running', done: 'done', waiting: 'waiting for you', failed: 'failed', skipped: 'skipped',
    stopped: 'stopped', new: 'not started', pass: 'pass', fail: 'fail', skip: 'skipped' };
  var EMAIL = /^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/;
  var SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  var KINDS = { pdf: 'pdf', jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' };
  var MB = 1024 * 1024;

  var S = {
    status: null, slug: null, venue: null, seq: 0, follow: 0, pollTimer: null, streamAbort: null,
    files: [], fileSeq: 0, slugEdited: false, slugTimer: null,
    pack: null, saveTimer: null, savePromise: null, saveAgain: false, saveError: false, blockers: [], slugTaken: false, welcome: ''
  };

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function setText(id, t) { $(id).textContent = t || ''; }
  function fmtMB(n) { return n < MB ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB'; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  /* ---------- server ---------- */
  function api(method, url, body) {
    var opts = { method: method, headers: { 'X-Onboard-Token': TOKEN }, cache: 'no-store' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      var type = res.headers.get('content-type') || '';
      return (type.indexOf('json') >= 0 ? res.json() : res.text()).then(function (data) {
        if (!res.ok) {
          var e = new Error((data && data.error) || (typeof data === 'string' && data) || ('The tool answered HTTP ' + res.status + '.'));
          e.status = res.status; e.field = data && data.field;
          throw e;
        }
        return data;
      });
    }, function () {
      throw new Error('The tool is not answering. Is its window still open? Start it again with node tools/onboard.js ui.');
    });
  }

  /* ---------- views ---------- */
  function show(view) {
    ['v-keys', 'v-form', 'v-venue'].forEach(function (v) { $(v).hidden = v !== view; });
    if (view !== 'v-venue') stopFollowing();
    window.scrollTo(0, 0);
  }
  function fatal(msg) { var f = $('fatal'); f.textContent = msg || ''; f.hidden = !msg; }

  /* ---------- status, keys, venues list ---------- */
  function loadStatus() {
    return api('GET', '/api/status').then(function (st) {
      S.status = st;
      renderKeys();
      renderList();
      var dl = clear($('fonts'));
      (st.fonts || []).forEach(function (f) { dl.appendChild(h('option', { value: f })); });
      return st;
    });
  }
  function keysMissing() { var k = S.status && S.status.keys; return !k || k.admin !== 'set' || k.anthropic !== 'set'; }
  function renderKeys() {
    var k = S.status.keys, pill = $('keys-pill');
    pill.textContent = 'Keys: admin ' + (k.admin === 'set' ? 'set' : 'missing') + ', Anthropic ' + (k.anthropic === 'set' ? 'set' : 'missing');
    pill.classList.toggle('warn', keysMissing());
    [['k-admin-st', k.admin], ['k-anthropic-st', k.anthropic]].forEach(function (x) {
      var el = $(x[0]); el.textContent = x[1] === 'set' ? 'set' : 'missing'; el.className = 'st ' + x[1];
    });
  }
  function saveKeys() {
    var body = { admin: $('k-admin').value.trim(), anthropic: $('k-anthropic').value.trim() };
    if (!body.admin && !body.anthropic) { setStatus('k-status', 'Paste a key first.', 'err'); return; }
    $('k-save').disabled = true;
    api('POST', '/api/keys', body).then(function (r) {
      $('k-admin').value = ''; $('k-anthropic').value = '';
      S.status.keys = r.keys;
      renderKeys();
      setStatus('k-status', keysMissing() ? 'Saved for this session. One key is still missing.' : 'Both keys are set for this session.', 'ok');
      if (!keysMissing()) setTimeout(function () { if (!$('v-keys').hidden) afterKeys(); }, 700);
    }, function (e) { setStatus('k-status', e.message, 'err'); }).then(function () { $('k-save').disabled = false; });
  }
  function afterKeys() { if (S.slug) openVenue(S.slug); else openForm(); }
  function openKeys() { setStatus('k-status', ''); show('v-keys'); $('k-admin').focus(); }

  function statusLine(v) {
    var step = v.lastStep, word = STATUS_WORDS[v.status] || v.status;
    if (v.status === 'done') return v.slug + ', live';
    return v.slug + ', ' + step + ' ' + (v.status === 'waiting' ? 'waiting' : word);
  }
  function renderList() {
    var ul = clear($('venue-list')), list = S.status.venues || [];
    $('venue-empty').hidden = list.length > 0;
    list.forEach(function (v) {
      ul.appendChild(h('li', null, h('button', { type: 'button', 'aria-current': v.slug === S.slug && !$('v-venue').hidden ? 'true' : 'false',
        onclick: function () { openVenue(v.slug); } },
        h('span', { class: 'vn', text: v.name + (v.place ? ', ' + v.place : '') }),
        h('span', { class: 'badge ' + v.status, text: STATUS_WORDS[v.status] || v.status }),
        h('span', { class: 'vs', text: statusLine(v) }))));
    });
  }
  function refreshList() { return loadStatus().catch(function () { /* the next refresh will do */ }); }

  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }

  /* ---------- new venue form ---------- */
  function slugify(name) {
    var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');
    return s || 'venue';
  }
  function openForm() {
    S.slug = null;
    history.replaceState(null, '', location.pathname + location.search);
    show('v-form');
    renderList();
    if (!$('staff-rows').children.length) addStaffRow();
    $('f-name').focus();
  }
  function fieldError(field, msg) {
    var e = $('e-' + field); if (e) e.textContent = msg || '';
    var input = { name: 'f-name', place: 'f-place', slug: 'f-slug', rate: 'f-rate', tables: 'f-tables', owner: 'f-owner', brand: 'f-brand', bg: 'f-bg', font: 'f-font' }[field];
    if (input) { if (msg) $(input).setAttribute('aria-invalid', 'true'); else $(input).removeAttribute('aria-invalid'); }
    return !msg;
  }
  function textRule(label, v, required) {
    if (required && !v) return label + ' is required.';
    if (v.length > 40) return label + ' is longer than 40 characters.';
    if (/["\\\u0000-\u001f]/.test(v)) return label + ' cannot contain double quotes or backslashes.';
    return '';
  }
  function currency() { var c = document.querySelector('input[name="cur"]:checked'); return c ? c.value : 'USD'; }
  function staffRows() {
    return Array.prototype.map.call($('staff-rows').children, function (row) {
      return { email: row.querySelector('input').value.trim().toLowerCase(), role: row.querySelector('select').value };
    });
  }
  function validateForm(all) {
    var ok = true, name = $('f-name').value.trim(), place = $('f-place').value.trim(), slug = $('f-slug').value.trim();
    ok = fieldError('name', textRule('The name', name, true)) && ok;
    ok = fieldError('place', textRule('The place', place, false)) && ok;
    ok = fieldError('slug', !slug ? 'The short name is required.' : slug.length > 40 || !SLUG.test(slug)
      ? 'Use lower-case letters, digits and hyphens only, up to 40 characters, not starting or ending with a hyphen.'
      : slug === 'index' ? 'The short name "index" is reserved.' : S.slugTaken ? 'This short name is already in the list on the left. Open it there, or choose another.' : '') && ok;
    if (currency() === 'LBP') {
      var r = $('f-rate').value.replace(/[,\s]/g, '');
      var n = Number(r);
      ok = fieldError('rate', r && !(n === Math.floor(n) && n >= 1000 && n <= 10000000) ? 'A whole number from 1,000 to 10,000,000.' : '') && ok;
    } else fieldError('rate', '');
    if (all) {
      var t = Number($('f-tables').value);
      ok = fieldError('tables', !(t === Math.floor(t) && t >= 1 && t <= 200) ? 'A whole number from 1 to 200.' : '') && ok;
      var owner = $('f-owner').value.trim().toLowerCase();
      ok = fieldError('owner', !EMAIL.test(owner) ? 'Enter the owner\'s email address.' : '') && ok;
      var seen = {}, staffErr = '';
      seen[owner] = 'owner';
      staffRows().forEach(function (s, i) {
        if (staffErr || !s.email) return;
        if (!EMAIL.test(s.email)) staffErr = 'Row ' + (i + 1) + ': not a valid email address.';
        else if (seen[s.email]) staffErr = 'Row ' + (i + 1) + ': ' + s.email + (seen[s.email] === 'owner' ? ' is the owner email already.' : ' is listed twice.');
        seen[s.email] = 'staff';
      });
      ok = fieldError('staff', staffErr) && ok;
      ok = fieldError('files', !S.files.length ? 'Add the menu: a PDF or photos of its pages.' : '') && ok;
      ['brand', 'bg'].forEach(function (k) {
        var v = $('f-' + k).value.trim();
        ok = fieldError(k, v && !/^#?[0-9A-Fa-f]{6}$/.test(v) ? 'A six digit hex colour, like ' + (k === 'brand' ? '#EA312B' : '#F0EFEA') + '.' : '') && ok;
      });
      var font = $('f-font').value.trim();
      ok = fieldError('font', font && !/^[A-Za-z0-9 +]{1,40}$/.test(font) ? 'A Google Fonts name: letters, digits and spaces.' : '') && ok;
      if (!ok) { $('more').open = $('more').open || !!($('e-brand').textContent || $('e-bg').textContent || $('e-font').textContent); }
    }
    return ok;
  }
  function onName() {
    if (!S.slugEdited) $('f-slug').value = $('f-name').value.trim() ? slugify($('f-name').value) : '';
    checkSlugSoon();
  }
  function checkSlugSoon() {
    clearTimeout(S.slugTimer);
    S.slugTimer = setTimeout(checkSlug, 300);
  }
  function checkSlug() {
    var slug = $('f-slug').value.trim();
    S.slugTaken = false;
    $('f-packnote').hidden = true;
    validateForm(false);
    if (!slug || !SLUG.test(slug)) return;
    api('GET', '/api/slug?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.slug !== $('f-slug').value.trim()) return;
      S.slugTaken = !!r.taken;
      validateForm(false);
      if (r.pack && !r.taken) {
        $('f-packtext').textContent = 'venues/' + slug + '.json already exists (' + r.pack.items + ' dishes). The tool keeps it and shows it to you at the menu check, unless you tick this box.';
        $('f-packnote').hidden = false;
      }
    }, function () { /* checked again on submit */ });
  }
  function addStaffRow(email, role) {
    var row = h('div', { class: 'staff-row' },
      h('input', { class: 'in', type: 'email', placeholder: 'name@restaurant.com', 'aria-label': 'Staff email', autocomplete: 'off', spellcheck: 'false' }),
      h('select', { class: 'in', 'aria-label': 'Role' }, h('option', { value: 'waiter', text: 'Waiter' }), h('option', { value: 'manager', text: 'Manager' }), h('option', { value: 'owner', text: 'Owner' })),
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Remove this person', text: 'Remove', onclick: function () { row.remove(); } }));
    if (email) row.querySelector('input').value = email;
    if (role) row.querySelector('select').value = role;
    $('staff-rows').appendChild(row);
    return row;
  }

  function addFiles(list) {
    var errs = [], total = S.files.reduce(function (a, f) { return a + f.size; }, 0), max = (S.status && S.status.maxUpload) || 40 * MB;
    Array.prototype.forEach.call(list, function (file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase(), kind = KINDS[ext];
      if (!kind) { errs.push(file.name + ': ' + (/^hei[cf]$/.test(ext) ? 'iPhone HEIC photos are not read; export them as JPEG first.' : 'only PDF, JPG, PNG and WebP files.')); return; }
      if (kind !== 'pdf' && file.size > ((S.status && S.status.maxImage) || 5 * MB)) { errs.push(file.name + ' is over 5 MB: resize the photo and add it again.'); return; }
      if (total + file.size > max) { errs.push(file.name + ' would take the files over 40 MB in total.'); return; }
      total += file.size;
      S.files.push({ id: ++S.fileSeq, file: file, name: file.name, size: file.size, kind: kind, url: kind === 'pdf' ? null : URL.createObjectURL(file) });
    });
    fieldError('files', errs.join(' '));
    renderFiles();
  }
  function moveFile(i, d) {
    var j = i + d;
    if (j < 0 || j >= S.files.length) return;
    var t = S.files[i]; S.files[i] = S.files[j]; S.files[j] = t;
    renderFiles();
    var btn = $('file-list').children[j].querySelector(d < 0 ? '[data-up]' : '[data-down]');
    if (btn && !btn.disabled) btn.focus();
  }
  function renderFiles() {
    var ol = clear($('file-list')), total = 0, photos = 0;
    S.files.forEach(function (f, i) {
      total += f.size;
      if (f.kind !== 'pdf') photos++;
      ol.appendChild(h('li', null,
        h('span', { class: 'pg', text: f.kind === 'pdf' ? 'PDF' : 'Page ' + (S.files.slice(0, i + 1).filter(function (x) { return x.kind !== 'pdf'; }).length) }),
        f.url ? h('img', { class: 'th', src: f.url, alt: '' }) : h('span', { class: 'th', text: 'PDF' }),
        h('span', null, h('span', { class: 'fn', text: f.name }), h('span', { class: 'fs', text: fmtMB(f.size) })),
        h('span', { class: 'fb' },
          h('button', { class: 'btn icon', type: 'button', 'data-up': '1', 'aria-label': 'Move ' + f.name + ' up', text: '↑', disabled: i === 0, onclick: function () { moveFile(i, -1); } }),
          h('button', { class: 'btn icon', type: 'button', 'data-down': '1', 'aria-label': 'Move ' + f.name + ' down', text: '↓', disabled: i === S.files.length - 1, onclick: function () { moveFile(i, 1); } }),
          h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Remove ' + f.name, text: 'Remove', onclick: function () {
            if (f.url) URL.revokeObjectURL(f.url);
            S.files.splice(i, 1); renderFiles();
          } }))));
    });
    $('file-total').textContent = S.files.length ? S.files.length + ' file' + (S.files.length > 1 ? 's' : '') + ', ' + fmtMB(total) + ' of 40 MB' +
      (photos > 1 ? '. The photos are read in this order.' : '') +
      (total > 30 * MB && !($('f-brand').value && $('f-bg').value && $('f-font').value) ? ' Over 30 MB the colours cannot be read from the menu: set them below.' : '') : '';
  }
  function readB64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { reject(new Error(file.name + ' could not be read. Add it again.')); };
      r.readAsDataURL(file);
    });
  }
  function submitForm(ev) {
    ev.preventDefault();
    setStatus('f-status', '', 'err');
    if (!validateForm(true)) { setStatus('f-status', 'Some fields need a look: see the messages in red.', 'err'); focusFirstError(); return; }
    var btn = $('f-submit');
    btn.disabled = true;
    btn.textContent = 'Sending the menu files...';
    Promise.all(S.files.map(function (f) { return readB64(f.file).then(function (data) { return { name: f.name, data: data }; }); })).then(function (files) {
      var rate = $('f-rate').value.replace(/[,\s]/g, '');
      return api('POST', '/api/venues', {
        name: $('f-name').value.trim(), place: $('f-place').value.trim(), slug: $('f-slug').value.trim(), currency: currency(),
        rate: currency() === 'LBP' && rate ? Number(rate) : null, tables: Number($('f-tables').value), owner: $('f-owner').value.trim(),
        staff: staffRows().filter(function (s) { return s.email; }), files: files, reimport: !$('f-packnote').hidden && $('f-reimport').checked,
        brand: $('f-brand').value.trim(), bg: $('f-bg').value.trim(), font: $('f-font').value.trim()
      });
    }).then(function (r) {
      resetForm();
      return refreshList().then(function () { openVenue(r.slug); });
    }, function (e) {
      if (e.field) { fieldError(e.field, e.message); focusFirstError(); }
      setStatus('f-status', e.message, 'err');
    }).then(function () { btn.disabled = false; btn.textContent = 'Start onboarding'; });
  }
  function focusFirstError() {
    var first = document.querySelector('#form [aria-invalid="true"]') || Array.prototype.filter.call(document.querySelectorAll('#form .err-t'), function (e) { return e.textContent; })[0];
    if (first) { first.scrollIntoView({ block: 'center' }); if (first.focus) first.focus(); }
  }
  function resetForm() {
    $('form').reset();
    S.files.forEach(function (f) { if (f.url) URL.revokeObjectURL(f.url); });
    S.files = []; S.slugEdited = false; S.slugTaken = false;
    clear($('staff-rows')); renderFiles();
    $('rate-box').hidden = true; $('f-packnote').hidden = true;
    ['s-brand', 's-bg'].forEach(function (id) { $(id).style.background = ''; });
  }

  /* ---------- one venue ---------- */
  function stopFollowing() {
    S.follow++;
    if (S.streamAbort) { try { S.streamAbort.abort(); } catch (e) { /* done */ } S.streamAbort = null; }
    clearTimeout(S.pollTimer);
  }
  function openVenue(slug) {
    stopFollowing();
    flushSave();
    S.slug = slug;
    S.pack = null;
    if (location.hash !== '#v=' + slug) history.replaceState(null, '', location.pathname + location.search + '#v=' + slug);
    return api('GET', '/api/venues/' + slug + '?since=0').then(function (r) {
      show('v-venue');
      clear($('log'));
      S.seq = 0;
      r.events.forEach(function (ev) { applyEvent(ev, true); });
      S.seq = Math.max(S.seq, r.venue.seq || 0);
      renderVenue(r.venue);
      $('log').scrollTop = $('log').scrollHeight;
      refreshList();
      if (r.venue.running) follow();
    }, function (e) {
      if (e.status === 404) { S.slug = null; refreshList(); openForm(); setStatus('f-status', e.message, 'err'); }
      else fatal(e.message);
    });
  }
  function refreshVenue() {
    var slug = S.slug;
    return api('GET', '/api/venues/' + slug + '?since=' + S.seq).then(function (r) {
      if (slug !== S.slug) return;
      r.events.forEach(function (ev) { applyEvent(ev, true); });
      renderVenue(r.venue);
      refreshList();
      if (r.venue.running) follow();
    }, function (e) { fatal(e.message); });
  }

  function renderVenue(v) {
    S.venue = v;
    setText('vh-name', v.name + (v.place ? ', ' + v.place : ''));
    var files = v.inputs.files || [];
    setText('vh-sub', v.slug + '  ·  ' + v.inputs.tables + ' tables  ·  ' + v.inputs.currency + (v.inputs.rate ? ' at ' + v.inputs.rate.toLocaleString('en-US') + ' LBP per USD' : '') +
      '  ·  owner ' + v.inputs.owner + (v.inputs.staff.length ? ' and ' + v.inputs.staff.length + ' staff' : '') + '  ·  ' + files.length + ' menu file' + (files.length === 1 ? '' : 's'));
    var badge = $('vh-status');
    badge.className = 'badge ' + v.status;
    badge.textContent = v.running ? 'running ' + (v.lastStep || '') : STATUS_WORDS[v.status] || v.status;
    renderSteps(v.steps);

    var failed = v.steps.filter(function (s) { return s.status === 'failed'; })[0];
    $('fail-box').hidden = !failed || v.running;
    if (failed) {
      setText('fail-text', 'Step ' + (failed.index + 1) + ', ' + failed.name + ', failed: ' + (failed.error || failed.summary));
      var keyIssue = /AALAYNA_ADMIN_KEY|ANTHROPIC_API_KEY|Admin key required|api[- ]key|authentication/i.test(failed.error || failed.summary);
      setText('fail-hint', keyIssue ? 'Enter the right key for this session, then press Run again.' : 'Fix the cause, then press Run again: finished steps are not repeated.');
      $('fail-keys').hidden = !keyIssue;
    }
    var menu = v.steps[2];
    var atCheck = !v.running && v.pack && (menu.status === 'waiting' || (menu.status === 'failed' && v.steps[0].status === 'done'));
    var settled = v.steps.every(function (s) { return s.status === 'done' || s.status === 'skipped'; });
    $('a-resume').hidden = v.running || !(v.status === 'failed' || v.status === 'stopped' || v.status === 'new');
    $('a-reset').hidden = v.running || v.status === 'done';
    $('check-card').hidden = !atCheck;
    $('done-card').hidden = !(settled && !v.running);
    if (atCheck && !S.pack) loadPack();
    if (!atCheck) S.pack = null;
    if (settled && !v.running) renderDone(v);
    $('log-box').open = v.running || !(atCheck || settled);
  }
  function renderSteps(steps) {
    var ol = clear($('steps'));
    steps.forEach(function (s) {
      ol.appendChild(h('li', { 'data-step': s.name },
        h('span', { class: 'no', text: String(s.index + 1) }),
        h('span', { class: 'nm' }, STEP_TITLES[s.name] || s.name, h('small', { text: s.name })),
        h('span', null, h('span', { class: 'badge ' + s.status, text: STATUS_WORDS[s.status] || s.status })),
        h('span', { class: 'sm', text: s.status === 'running' ? 'working on it...' : s.summary || '' })));
    });
  }
  function patchStep(ev) {
    if (!S.venue) return;
    var s = S.venue.steps[ev.index];
    if (!s) return;
    s.status = ev.status;
    if (ev.status !== 'running') s.summary = ev.summary;
    if (ev.status === 'failed') s.error = ev.summary;
    S.venue.running = true;
    S.venue.lastStep = ev.step;
    renderSteps(S.venue.steps);
    var badge = $('vh-status');
    badge.className = 'badge running';
    badge.textContent = 'running ' + ev.step;
  }

  /* ---------- log and live progress ---------- */
  function logLine(text, kind) {
    var pre = $('log'), atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.appendChild(document.createTextNode((pre.firstChild ? '\n' : '') + text));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
  var KIND_WORDS = { start: 'the first run', resume: 'run again', approve: 'approve and publish', reimport: 're-extract' };
  function applyEvent(ev, quiet) {
    if (ev.seq && ev.seq <= S.seq) return;
    if (ev.seq) S.seq = ev.seq;
    if (ev.type === 'log') logLine(ev.line);
    else if (ev.type === 'start') logLine((S.seq > 1 && $('log').firstChild ? '\n' : '') + '> ' + (KIND_WORDS[ev.kind] || ev.kind) + ', ' + new Date().toLocaleTimeString());
    else if (ev.type === 'step' && !quiet) patchStep(ev);
    else if (ev.type === 'end' && !quiet) { stopFollowing(); refreshVenue(); }
  }
  function follow() {
    var mine = ++S.follow;
    if (!window.ReadableStream || !window.AbortController || !window.TextDecoder) return poll(mine);
    var ctl = new AbortController();
    S.streamAbort = ctl;
    fetch('/api/venues/' + S.slug + '/events?since=' + S.seq, { headers: { 'X-Onboard-Token': TOKEN }, signal: ctl.signal, cache: 'no-store' }).then(function (res) {
      if (!res.ok || !res.body || !res.body.getReader) throw new Error('no stream');
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (mine !== S.follow) { try { reader.cancel(); } catch (e) { /* gone */ } return; }
          if (r.done) { refreshVenue(); return; }                       // idle or end: read the venue once more
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (block) {
            var type = 'message', data = '';
            block.split('\n').forEach(function (l) {
              if (l.indexOf('event: ') === 0) type = l.slice(7);
              else if (l.indexOf('data: ') === 0) data += l.slice(6);
            });
            if (!data || type === 'idle') return;
            try { applyEvent(JSON.parse(data)); } catch (e) { /* a broken line is skipped */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (mine === S.follow) poll(mine);                                // no stream: poll instead
    });
  }
  function poll(mine) {
    if (mine !== S.follow) return;
    api('GET', '/api/venues/' + S.slug + '?since=' + S.seq).then(function (r) {
      if (mine !== S.follow) return;
      r.events.forEach(function (ev) { if (ev.type !== 'end') applyEvent(ev); });
      if (r.venue.running) S.pollTimer = setTimeout(function () { poll(mine); }, 1500);
      else { renderVenue(r.venue); refreshList(); }
    }, function () { if (mine === S.follow) S.pollTimer = setTimeout(function () { poll(mine); }, 3000); });
  }

  function act(action, confirmFirst) {
    var slug = S.slug;
    var go = function () {
      return flushSave().then(function () {
        if (action === 'approve' && S.saveError) throw new Error('The last change was not saved: fix the message in red above the table first.');
        return api('POST', '/api/venues/' + slug + '/' + action, {});
      }).then(function (r) {
        if (action === 'reset') {
          S.slug = null;
          return refreshList().then(function () { openForm(); setStatus('f-status', 'Forgot the onboarding of ' + slug + '. The venue and its codes stay on the server; a new start with the same short name finds them again.', 'ok'); });
        }
        return openVenue(slug);
      }, function (e) {
        if (action === 'approve' || action === 'reimport') setStatus('ck-status', e.message, 'err');
        else fatal(e.message);
      });
    };
    if (!confirmFirst) return go();
    return ask(confirmFirst[0], confirmFirst[1], confirmFirst[2]).then(function (yes) { if (yes) go(); });
  }

  /* ---------- checkpoint: the pack, editable ---------- */
  function loadPack() {
    var slug = S.slug;
    setStatus('ck-status', '');
    api('GET', '/api/venues/' + slug + '/pack').then(function (r) {
      if (slug !== S.slug) return;
      S.pack = r.pack; S.blockers = r.blockers || [];
      var menu = S.venue.steps[2];
      setText('ck-intro', (menu.status === 'failed' ? 'Publishing stopped: ' + (menu.error || menu.summary) + ' ' : '') +
        'This is the menu the tool read. Fix names, prices and allergens here; every change is saved to ' + S.venue.pack.path +
        ' as you type. Nothing reaches guests until you press Approve and publish.');
      $('ck-report').textContent = r.report || 'No report: the menu file was already there, so it was not read again.';
      renderPack();
      setSave('', '');
    }, function (e) { setStatus('ck-status', e.message, 'err'); });
  }
  function nameKey(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function packFlags() {
    var p = S.pack, count = {}, names = {}, rows = {};
    p.items.forEach(function (x) { count[x.sec] = (count[x.sec] || 0) + 1; var k = nameKey(x.name); if (k) names[k] = (names[k] || 0) + 1; });
    p.items.forEach(function (x) {
      var why = [];
      if (x.price == null || x.price === '') why.push('no price');
      if (names[nameKey(x.name)] > 1) why.push('name appears twice');
      if (!nameKey(x.name)) why.push('no name');
      rows[x.id] = why;
    });
    var empty = p.sections.filter(function (s) { return !count[s.id]; });
    return { rows: rows, count: count, empty: empty,
      noPrice: p.items.filter(function (x) { return x.price == null; }).length,
      dup: Object.keys(names).filter(function (k) { return names[k] > 1; }).length };
  }
  function renderFlags(f) {
    var box = clear($('ck-flags'));
    box.appendChild(h('span', { class: 'badge', text: S.pack.items.length + ' dishes in ' + S.pack.sections.length + ' sections' }));
    box.appendChild(h('span', { class: 'badge ' + (f.noPrice ? 'waiting' : 'done'), text: f.noPrice + ' without a price' }));
    box.appendChild(h('span', { class: 'badge ' + (f.dup ? 'waiting' : 'done'), text: f.dup + ' name' + (f.dup === 1 ? '' : 's') + ' twice' }));
    box.appendChild(h('span', { class: 'badge ' + (f.empty.length ? 'waiting' : 'done'), text: f.empty.length + ' empty section' + (f.empty.length === 1 ? '' : 's') }));
    var blocked = f.noPrice > 0 || S.blockers.length > 0;
    $('ck-block').hidden = !blocked;
    $('ck-block').textContent = f.noPrice ? 'Approve is off until every dish has a price (' + f.noPrice + ' to go). Write one in, or delete the row.' :
      S.blockers.length ? 'Approve is off: ' + S.blockers.join('; ') + '.' : '';
    $('ck-approve').disabled = blocked;
  }
  function updateFlags() {
    var f = packFlags();
    renderFlags(f);
    Array.prototype.forEach.call(document.querySelectorAll('#ck-table tr[data-id]'), function (tr) {
      var why = f.rows[tr.getAttribute('data-id')] || [];
      tr.classList.toggle('flag', why.length > 0);
      tr.querySelector('.why').textContent = why.join(', ');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#ck-table tr[data-sec]'), function (tr) {
      var n = f.count[tr.getAttribute('data-sec')] || 0;
      tr.querySelector('.scount').textContent = n ? n + ' dish' + (n === 1 ? '' : 'es') : 'no dishes';
    });
  }
  function renderPack() {
    var p = S.pack, f = packFlags(), allergens = (S.status && S.status.allergens) || [];
    renderFlags(f);
    var tb = h('table', { class: 'pack' }, h('thead', null, h('tr', null,
      h('th', { text: 'Dish' }), h('th', { text: 'Arabic name' }), h('th', { text: 'Description' }), h('th', { text: 'Price, $' }), h('th', { text: 'Allergens' }), h('th', null))));
    p.sections.forEach(function (sec) {
      var body = h('tbody');
      var items = p.items.filter(function (x) { return x.sec === sec.id; });
      var head = h('tr', { class: 'sec', 'data-sec': sec.id }, h('td', { colspan: '6' },
        h('span', { class: 'sname', text: sec.name }), h('span', { class: 'scount', text: items.length ? items.length + ' dish' + (items.length === 1 ? '' : 'es') : 'no dishes' }),
        !items.length ? h('span', null, ' ', h('span', { class: 'badge waiting', text: 'empty: guests would see a heading with nothing under it' }), ' ',
          h('button', { class: 'btn small', type: 'button', text: 'Delete section', onclick: function () {
            p.sections = p.sections.filter(function (s) { return s.id !== sec.id; }); renderPack(); saveSoon();
          } })) : null));
      body.appendChild(head);
      items.forEach(function (x) { body.appendChild(itemRow(x, f.rows[x.id] || [], allergens)); });
      tb.appendChild(body);
    });
    clear($('ck-table')).appendChild(h('div', { class: 'pack-wrap' }, tb));
  }
  function itemRow(x, why, allergens) {
    var edit = function (fn) { return function (ev) { fn(ev.target.value); updateFlags(); saveSoon(); }; };
    x.tr = x.tr || {}; x.tr.ar = x.tr.ar || { n: '', d: '' }; x.tr.fr = x.tr.fr || { n: '', d: '' };
    var price = h('input', { class: 'in', inputmode: 'decimal', 'aria-label': 'Price of ' + x.name, value: x.price == null ? '' : String(x.price) });
    price.addEventListener('input', function () {
      var v = price.value.trim().replace(',', '.');
      if (v === '') { x.price = null; price.removeAttribute('aria-invalid'); }
      else if (/^\d+(\.\d{1,2})?$/.test(v)) { x.price = Number(v); price.removeAttribute('aria-invalid'); }
      else { price.setAttribute('aria-invalid', 'true'); setSave('A price is a number like 12 or 12.50: not saved yet.', 'err'); return; }
      updateFlags(); saveSoon();
    });
    var chips = h('div', { class: 'chips' });
    function drawChips() {
      clear(chips);
      (x.al || []).forEach(function (a) {
        chips.appendChild(h('button', { class: 'chip', type: 'button', title: 'Remove ' + a, 'aria-label': 'Remove allergen ' + a, text: a + ' ×', onclick: function () {
          x.al = x.al.filter(function (b) { return b !== a; }); drawChips(); saveSoon();
        } }));
      });
      var left = allergens.filter(function (a) { return (x.al || []).indexOf(a) < 0; });
      if (left.length) {
        var sel = h('select', { class: 'chip-add', 'aria-label': 'Add an allergen to ' + x.name }, h('option', { value: '', text: '+ add' }));
        left.forEach(function (a) { sel.appendChild(h('option', { value: a, text: a })); });
        sel.addEventListener('change', function () { if (!sel.value) return; x.al = (x.al || []).concat([sel.value]); drawChips(); saveSoon(); });
        chips.appendChild(sel);
      }
    }
    drawChips();
    var tr = h('tr', { 'data-id': x.id, class: why.length ? 'flag' : '' },
      h('td', { class: 'c-name' }, h('input', { class: 'in', value: x.name || '', 'aria-label': 'Dish name', oninput: edit(function (v) { x.name = v; }) }), h('span', { class: 'why', text: why.join(', ') })),
      h('td', { class: 'c-ar' }, h('input', { class: 'in', dir: 'rtl', lang: 'ar', value: x.tr.ar.n || '', 'aria-label': 'Arabic name of ' + x.name, oninput: edit(function (v) { x.tr.ar.n = v; }) })),
      h('td', { class: 'c-desc' }, h('input', { class: 'in', value: x.desc || '', 'aria-label': 'Description of ' + x.name, oninput: edit(function (v) { x.desc = v; }) })),
      h('td', { class: 'c-price' }, price),
      h('td', { class: 'c-al' }, chips),
      h('td', null, h('button', { class: 'btn small danger', type: 'button', text: 'Delete row', 'aria-label': 'Delete ' + x.name, onclick: function () {
        S.pack.items = S.pack.items.filter(function (y) { return y !== x; }); renderPack(); saveSoon();
      } })));
    return tr;
  }
  function setSave(msg, kind) { var el = $('ck-save'); el.textContent = msg; el.className = 'save' + (kind ? ' ' + kind : ''); }
  function saveSoon() {
    setSave('Saving...', '');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(savePack, 600);
  }
  /* the pending edit now, or the save already on its way; resolves once it has landed */
  function flushSave() {
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; return savePack(); }
    return S.savePromise || Promise.resolve();
  }
  function savePack() {
    S.saveTimer = null;
    if (!S.pack || !S.slug) return Promise.resolve();
    if (document.querySelector('#ck-table [aria-invalid="true"]')) { S.saveError = true; setSave('A price is a number like 12 or 12.50: not saved yet.', 'err'); return Promise.resolve(); }
    if (S.savePromise) { S.saveAgain = true; return S.savePromise; }
    var slug = S.slug, body = S.pack;
    S.savePromise = api('PUT', '/api/venues/' + slug + '/pack', body).then(function (r) {
      S.saveError = false;
      S.blockers = r.blockers || [];
      if (slug === S.slug && S.venue && S.venue.pack) { setSave('Saved to ' + S.venue.pack.path, 'ok'); renderFlags(packFlags()); }
    }, function (e) { S.saveError = true; if (slug === S.slug) setSave(e.message, 'err'); }).then(function () {
      S.savePromise = null;
      if (S.saveAgain) { S.saveAgain = false; return savePack(); }
    });
    return S.savePromise;
  }

  /* ---------- done ---------- */
  function renderDone(v) {
    setText('dn-title', v.name + ' is live');
    var ul = clear($('dn-checks'));
    if (!v.checks.length) ul.appendChild(h('li', null, h('span', { class: 'badge skip', text: 'none' }), h('span', { text: 'The live test did not run.' })));
    v.checks.forEach(function (c) {
      ul.appendChild(h('li', null, h('span', null, h('span', { class: 'badge ' + c.status, text: STATUS_WORDS[c.status] || c.status })),
        h('span', null, c.name, c.status !== 'pass' && c.detail ? h('span', { class: 'd', text: c.detail }) : null)));
    });
    setText('dn-cards-t', v.cards ? v.tables.count + ' cards, one per table. Print them on card stock; the header and the links under the cards do not print. The sheet holds the table codes: keep it private.' : 'The card sheet is not there.');
    $('dn-print').disabled = !v.cards;
    var todo = clear($('dn-todo'));
    v.checklist.forEach(function (l) {
      var done = l.indexOf('[x]') === 0;
      todo.appendChild(h('li', null, h('span', null, h('span', { class: 'box' + (done ? ' x' : ''), 'aria-label': done ? 'done' : 'to do' })), h('span', { text: l.slice(4) })));
    });
    $('dn-welcome-box').hidden = !v.welcome;
    $('dn-no-welcome').hidden = !!v.welcome;
    if (v.welcome) {
      var slug = v.slug;
      api('GET', '/api/venues/' + slug + '/welcome').then(function (md) { if (slug === S.slug) { S.welcome = md; renderNote(); } }, function (e) { setStatus('dn-copy-st', e.message, 'err'); });
    }
  }
  var PLACEHOLDER = '[WhatsApp number]';
  function filled(md) {
    var n = $('dn-wa').value.trim();
    return n ? md.split(PLACEHOLDER).join(n) : md;
  }
  function inline(parent, text) {
    // links and the placeholder; everything else stays text
    var re = /(https?:\/\/[^\s)]+)|(\[WhatsApp number\])/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.appendChild(h('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer', text: m[1] }));
      else parent.appendChild(h('mark', { text: m[2] }));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderNote() {
    var box = clear($('dn-note')), md = filled(S.welcome || ''), para = null, list = null;
    md.split('\n').forEach(function (line) {
      var t = line.replace(/\s+$/, '');
      if (!t) { para = null; list = null; return; }
      if (/^# /.test(t)) { box.appendChild(h('h3', { text: t.slice(2) })); para = list = null; return; }
      if (/^## /.test(t)) { box.appendChild(h('h4', { text: t.slice(3) })); para = list = null; return; }
      if (/^- /.test(t)) { if (!list) { list = h('ul'); box.appendChild(list); } var li = h('li'); inline(li, t.slice(2)); list.appendChild(li); para = null; return; }
      if (!para) { para = h('p', { dir: 'auto' }); box.appendChild(para); } else para.appendChild(h('br'));
      inline(para, t);
      list = null;
    });
  }
  /* WhatsApp shows *bold*, not Markdown headings */
  function forWhatsApp(md) {
    return md.split('\n').map(function (l) {
      l = l.replace(/\s+$/, '');
      if (/^#{1,2} /.test(l)) return '*' + l.replace(/^#{1,2} /, '') + '*';
      return l;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  function copyNote() {
    var text = forWhatsApp(filled(S.welcome || ''));
    var n = $('dn-wa').value.trim();
    var done = function () {
      setStatus('dn-copy-st', n ? 'Copied. Paste it into WhatsApp or an email to the owner.' : 'Copied, but your WhatsApp number is still a placeholder: fill it in and copy again.', n ? 'ok' : 'err');
    };
    var fallback = function () {
      var ta = h('textarea', { class: 'in' }); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { setStatus('dn-copy-st', 'Could not copy: select the note and copy it by hand.', 'err'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  /* ---------- confirm dialog ---------- */
  function ask(title, text, ok) {
    var d = $('dlg');
    setText('dlg-title', title); setText('dlg-text', text); setText('dlg-ok', ok);
    return new Promise(function (resolve) {
      var finish = function (v) { $('dlg-ok').onclick = $('dlg-cancel').onclick = null; d.onclose = null; if (d.open) d.close(); resolve(v); };
      $('dlg-ok').onclick = function () { finish(true); };
      $('dlg-cancel').onclick = function () { finish(false); };
      d.onclose = function () { finish(false); };
      if (d.showModal) d.showModal(); else resolve(window.confirm(title + '\n\n' + text));
      $('dlg-cancel').focus();
    });
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('keys-pill').addEventListener('click', openKeys);
    $('k-save').addEventListener('click', saveKeys);
    [$('k-admin'), $('k-anthropic')].forEach(function (i) { i.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveKeys(); }); });
    $('k-later').addEventListener('click', afterKeys);
    $('new-btn').addEventListener('click', openForm);
    $('form').addEventListener('submit', submitForm);
    $('f-name').addEventListener('input', onName);
    $('f-slug').addEventListener('input', function () { S.slugEdited = !!$('f-slug').value.trim(); checkSlugSoon(); });
    $('f-place').addEventListener('input', function () { validateForm(false); });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cur"]'), function (r) {
      r.addEventListener('change', function () {
        var lbp = currency() === 'LBP';
        $('rate-box').hidden = !lbp;
        if (lbp && !$('f-rate').value) $('f-rate').value = String((S.status && S.status.defaultRate) || 89500);
        validateForm(false);
      });
    });
    $('f-rate').addEventListener('input', function () { validateForm(false); });
    ['brand', 'bg'].forEach(function (k) {
      $('f-' + k).addEventListener('input', function () {
        var v = $('f-' + k).value.trim();
        $('s-' + k).style.background = /^#?[0-9A-Fa-f]{6}$/.test(v) ? (v[0] === '#' ? v : '#' + v) : '';
      });
    });
    $('staff-add').addEventListener('click', function () { addStaffRow().querySelector('input').focus(); });
    var drop = $('drop'), picker = $('f-files');
    drop.addEventListener('click', function () { picker.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    picker.addEventListener('change', function () { addFiles(picker.files); picker.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
    // a file dropped next to the zone must not replace the page
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('a-resume').addEventListener('click', function () { act('resume'); });
    $('a-reset').addEventListener('click', function () {
      act('reset', ['Start ' + S.slug + ' over?', 'The tool forgets how far this venue got and the menu files you gave it. The venue, its keys, its table codes and venues/' + S.slug +
        '.json stay as they are: filling in the form again with the same name and short name finds them again.', 'Start over']);
    });
    $('fail-keys-btn').addEventListener('click', openKeys);
    $('ck-approve').addEventListener('click', function () { setStatus('ck-status', ''); act('approve'); });
    $('ck-reimport').addEventListener('click', function () {
      act('reimport', ['Read the menu again?', 'The model reads the menu files again and replaces venues/' + S.slug + '.json. Every change you made on this page is lost.', 'Re-extract']);
    });
    $('dn-print').addEventListener('click', function () {
      if (S.venue && S.venue.cards) window.open(S.venue.cards + '?t=' + encodeURIComponent(TOKEN), '_blank', 'noopener');
    });
    var wa = recall('aal-onboard-whatsapp');
    if (wa) $('dn-wa').value = wa;
    $('dn-wa').addEventListener('input', function () { store('aal-onboard-whatsapp', $('dn-wa').value.trim() || null); if (S.welcome) renderNote(); });
    $('dn-copy').addEventListener('click', copyNote);
    window.addEventListener('beforeunload', flushSave);
    window.addEventListener('hashchange', function () {
      var m = /^#v=([a-z0-9-]{1,40})$/.exec(location.hash);
      if (m && m[1] !== S.slug) openVenue(m[1]);
    });
  }

  function start() {
    wire();
    if (!TOKEN) { fatal('This page only works from the address the tool printed. Run node tools/onboard.js ui and use the address it opens.'); return; }
    loadStatus().then(function () {
      var m = /^#v=([a-z0-9-]{1,40})$/.exec(location.hash);
      if (keysMissing()) { if (m) S.slug = m[1]; openKeys(); }
      else if (m) openVenue(m[1]);
      else openForm();
    }, function (e) { fatal(e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
