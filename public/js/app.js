// Clear the ?message= flag from the URL so a refresh does not repeat the banner
(function () {
  var url = new URL(window.location.href);
  var dirty = false;
  ['message', 'error'].forEach(function (key) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      dirty = true;
    }
  });
  if (dirty) window.history.replaceState({}, '', url.pathname + (url.search || ''));

  document.querySelectorAll('.alert-info, .alert-success').forEach(function (el) {
    setTimeout(function () { el.remove(); }, 5000);
  });
})();

// Show or hide the password on the sign-in form
(function () {
  var toggle = document.getElementById('togglePassword');
  var input = document.getElementById('password');
  if (!toggle || !input) return;

  toggle.addEventListener('click', function () {
    var hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    // Swap between the open and struck-through eye
    toggle.innerHTML = hidden
      ? '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 4"/><path d="M6.3 8.3A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.8 9.8 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
      : '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  });
})();

// Live preview for the item image URL on the product form
(function () {
  var input = document.getElementById('imageUrl');
  var box = document.getElementById('imagePreview');
  if (!input || !box) return;

  function render() {
    var url = input.value.trim();
    box.innerHTML = '';
    if (!url) {
      box.innerHTML = '<span class="preview-empty">No image yet</span>';
      return;
    }
    var img = document.createElement('img');
    img.alt = 'Preview';
    img.onerror = function () {
      box.innerHTML = '<span class="preview-empty">That image could not be loaded</span>';
    };
    img.src = url;
    box.appendChild(img);
  }

  input.addEventListener('change', render);
  input.addEventListener('blur', render);
  render();
})();

/**
 * Confirm-before-submit, declared on the form rather than in an inline
 * handler. Putting the sentence in an attribute means a studio called
 * "Lily's Loft" cannot break the page: the apostrophe is just text here,
 * whereas in an onsubmit string it would end the string early.
 */
(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-confirm]');
    if (!form) return;
    if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
  });
})();

/**
 * The studio add/edit dialog on /admin/studios.
 *
 * One dialog serves both jobs. "Edit" carries the studio's current values on
 * the button itself, so opening it costs no request and the super admin never
 * leaves the page they were looking at — which was the whole problem with
 * having a separate form screen.
 *
 * The code field is disabled when editing: it is already printed on every
 * asset tag in that studio, so changing it would orphan all of them.
 */
(function () {
  var modal = document.getElementById('studioModal');
  if (!modal) return;

  var form      = document.getElementById('studioForm');
  var titleEl   = document.getElementById('studioModalTitle');
  var subEl     = document.getElementById('studioModalSub');
  var errorEl   = document.getElementById('studioModalError');
  var submitEl  = document.getElementById('studioSubmit');
  var noteEl    = document.getElementById('studioNewNote');
  var codeEl    = document.getElementById('studioCode');
  var codeHelp  = document.getElementById('studioCodeHelp');
  var lastFocus = null;

  var field = function (id) { return document.getElementById(id); };

  function open() {
    lastFocus = document.activeElement;
    modal.classList.add('is-open');
    document.body.classList.add('modal-open');
    var first = form.querySelector('input:not([disabled])');
    if (first) first.focus();
  }

  function close() {
    modal.classList.remove('is-open');
    document.body.classList.remove('modal-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function reset() {
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
  }

  function openNew() {
    reset();
    form.setAttribute('action', '/admin/studios');
    titleEl.textContent = 'New studio';
    subEl.textContent = 'The code becomes the prefix on every asset tag at this studio';
    submitEl.textContent = 'Create studio';
    if (noteEl) noteEl.hidden = false;

    ['studioName', 'studioCity', 'studioPhone', 'studioAddress'].forEach(function (id) {
      field(id).value = '';
    });
    codeEl.value = '';
    codeEl.disabled = false;
    codeHelp.textContent = '2–5 letters. Tags become PAT-0001, PAT-0002 and so on.';
    field('studioTheme').value = 'blue';

    open();
  }

  function openEdit(btn) {
    reset();
    var d = btn.dataset;
    form.setAttribute('action', '/admin/studios/' + d.id + '?_method=PUT');
    titleEl.textContent = 'Edit ' + d.name;
    subEl.textContent = 'The code cannot change — it is already printed on this studio’s asset tags';
    submitEl.textContent = 'Save changes';
    if (noteEl) noteEl.hidden = true;

    field('studioName').value    = d.name || '';
    field('studioCity').value    = d.city || '';
    field('studioPhone').value   = d.phone || '';
    field('studioAddress').value = d.address || '';
    field('studioTheme').value   = d.theme || 'blue';

    codeEl.value = d.code || '';
    codeEl.disabled = true;
    codeHelp.textContent = 'Fixed — every asset tag here already starts with it.';

    open();
  }

  document.addEventListener('click', function (e) {
    var addBtn = e.target.closest('[data-studio-new]');
    if (addBtn) { e.preventDefault(); openNew(); return; }

    var editBtn = e.target.closest('[data-studio-edit]');
    if (editBtn) { e.preventDefault(); openEdit(editBtn); return; }

    // Cancel, the X, and clicking the dark area around the dialog
    if (e.target.closest('[data-studio-close]') || e.target === modal) close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });

  // A rejected save re-renders the page with the dialog already open
  if (modal.classList.contains('is-open')) {
    document.body.classList.add('modal-open');
  }
})();

/**
 * Filter the studio grid as you type. Purely client-side: every studio is
 * already on the page, so there is no reason to make a round trip for it.
 */
(function () {
  var input = document.getElementById('studioSearch');
  var grid = document.getElementById('studioGrid');
  if (!input || !grid) return;

  var empty = document.getElementById('studioSearchEmpty');
  var cards = grid.querySelectorAll('[data-studio-search]');

  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var shown = 0;

    cards.forEach(function (card) {
      var hit = !q || card.getAttribute('data-studio-search').indexOf(q) !== -1;
      card.hidden = !hit;
      if (hit) shown++;
    });

    // The add tile is not a studio, so it steps aside during a search
    var addTile = grid.querySelector('.studio-card-add');
    if (addTile) addTile.hidden = Boolean(q);
    if (empty) empty.hidden = shown !== 0;
  });
})();

/**
 * The master dashboard's side panel.
 *
 * Every card, row and list on that page can open a panel on the right rather
 * than navigating away — the whole point being that a super admin drilling
 * into "which 15 items are out?" should not lose the dashboard they were
 * reading. An opener declares three things on itself:
 *
 *   data-panel   which panel to load
 *   data-params  an optional query string for it
 *   data-title   what to call it in the header
 *
 * Contents are fetched when the panel opens, never rendered up-front, so a
 * page with six drill-downs behind it stays the size of a page with none.
 */
(function () {
  var drawer = document.getElementById('drawer');
  if (!drawer) return;

  var backdrop = document.getElementById('drawerBackdrop');
  var body = document.getElementById('drawerBody');
  var titleEl = document.getElementById('drawerTitle');
  var backBtn = document.getElementById('drawerBack');

  // Where we have been, so a panel opened from inside a panel can go back
  var trail = [];
  var lastFocus = null;

  /**
   * What is currently open, kept in a closure rather than on the element.
   *
   * It used to live in drawer.dataset.panel, which quietly broke Close and
   * Back: the openers are matched with closest('[data-panel]'), and that
   * attribute on the drawer meant every click inside it — the close button
   * included — walked up, found the drawer, and was treated as a request to
   * reopen the panel. State the markup does not need does not belong in the
   * markup.
   */
  var current = { panel: null, params: '' };

  function url(panel, params) {
    return '/admin/master/panel/' + encodeURIComponent(panel) + (params ? '?' + params : '');
  }

  function open() {
    if (drawer.classList.contains('is-open')) return;
    lastFocus = document.activeElement;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    document.body.classList.add('drawer-open');
  }

  function close() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
    document.body.classList.remove('drawer-open');
    trail = [];
    current = { panel: null, params: '' };
    backBtn.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /** Fetches a panel's markup into the body. Shared by opening and filtering. */
  function fetchInto(panel, params, keepScroll) {
    var at = keepScroll ? body.scrollTop : 0;
    if (!keepScroll) body.innerHTML = '<p class="panel-loading">Loading…</p>';

    return fetch(url(panel, params), { headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) {
        if (!r.ok) throw new Error('That panel could not be loaded (' + r.status + ')');
        return r.text();
      })
      .then(function (html) {
        body.innerHTML = html;
        body.scrollTop = at;
      })
      .catch(function (err) {
        body.innerHTML = '<p class="panel-error">' + err.message + '</p>';
      });
  }

  function load(panel, params, title, isBack) {
    // Remember where we came from, but only once we are actually nested
    if (!isBack && drawer.classList.contains('is-open') && current.panel) {
      trail.push({ panel: current.panel, params: current.params, title: titleEl.textContent });
    }

    current = { panel: panel, params: params || '' };
    titleEl.textContent = title || 'Details';
    backBtn.hidden = trail.length === 0;
    open();
    fetchInto(panel, params, false);
  }

  /**
   * Re-runs the panel you are already looking at with new filters. It is not
   * a new panel, so it does not go on the trail — Back should take you to
   * where you came from, not through every search you typed on the way.
   */
  function refilter(params) {
    if (!current.panel) return;
    current.params = params;
    fetchInto(current.panel, params, false);
  }

  document.addEventListener('click', function (e) {
    /**
     * The drawer's own controls are checked first. They live inside the
     * drawer, so anything that treats a click in there as an opener has to
     * come after them.
     */
    if (e.target.closest('#drawerClose') || e.target === backdrop) {
      e.preventDefault();
      close();
      return;
    }

    if (e.target.closest('#drawerBack')) {
      e.preventDefault();
      var previous = trail.pop();
      if (previous) load(previous.panel, previous.params, previous.title, true);
      else close();
      return;
    }

    // Opening a panel. A row may be clickable while still holding its own
    // buttons, so a click on a button inside it wins over the row.
    var opener = e.target.closest('[data-panel]');
    if (opener && !e.target.closest('a')) {
      e.preventDefault();
      load(opener.getAttribute('data-panel'), opener.getAttribute('data-params'), opener.getAttribute('data-title'));
      return;
    }

    // Clearing a panel's filters
    if (e.target.closest('[data-panel-clear]')) {
      e.preventDefault();
      refilter('');
      return;
    }

    // Approving or declining without leaving the queue. The server answers
    // with the refreshed queue, so the panel updates in place instead of
    // collapsing under whoever is working through it.
    var decide = e.target.closest('[data-decide]');
    if (decide) {
      e.preventDefault();
      var action = decide.getAttribute('data-decide');
      var note = null;

      if (action === 'reject') {
        note = window.prompt('Add a note for them (optional):', '');
        if (note === null) return; // they cancelled the prompt, not the request
      }

      var buttons = decide.closest('.panel-decide');
      if (buttons) buttons.querySelectorAll('button').forEach(function (b) { b.disabled = true; });

      fetch('/admin/master/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: new URLSearchParams({
          kind: decide.getAttribute('data-kind'),
          id: decide.getAttribute('data-id'),
          action: action,
          note: note || '',
        }).toString(),
      })
        .then(function (r) { return r.text(); })
        .then(function (html) { body.innerHTML = html; })
        .catch(function () {
          body.innerHTML = '<p class="panel-error">That could not be saved. Reload and try again.</p>';
        });
    }
  });

  /* ---------------- filtering inside a panel ---------------- */

  // Empty fields are dropped so the URL says only what was actually asked for
  function paramsOf(form) {
    var params = new URLSearchParams();
    new FormData(form).forEach(function (value, key) {
      if (String(value).trim()) params.set(key, String(value).trim());
    });
    return params.toString();
  }

  var typing = null;

  body.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-panel-filter]');
    if (!form) return;
    e.preventDefault();
    clearTimeout(typing);
    refilter(paramsOf(form));
  });

  // A dropdown applies at once; typing waits until they stop, so a five
  // letter search is one request rather than five
  body.addEventListener('change', function (e) {
    var form = e.target.closest('[data-panel-filter]');
    if (!form || e.target.type === 'search' || e.target.type === 'text') return;
    refilter(paramsOf(form));
  });

  body.addEventListener('input', function (e) {
    var form = e.target.closest('[data-panel-filter]');
    if (!form) return;
    if (e.target.type !== 'search' && e.target.type !== 'text') return;
    clearTimeout(typing);
    typing = setTimeout(function () { refilter(paramsOf(form)); }, 350);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
  });
})();

/**
 * Decline buttons that ask for a note first.
 *
 * The prompt lives here rather than in an inline onsubmit for the same
 * reason the archive confirmation does: the message is data on the form, so
 * an apostrophe in it is just a character instead of a syntax error.
 */
(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-note]');
    if (!form) return;
    var note = window.prompt(form.getAttribute('data-note'));
    if (note === null) { e.preventDefault(); return; }
    // The hidden field is called `note` on some forms and `remark` on
    // others; the prompt should not care which
    var field = form.querySelector('input[name="note"], input[name="remark"]');
    if (field) field.value = note;
  });
})();

/**
 * Asking for several items at once, on the staff inventory page.
 *
 * The bar stays out of the way until something is ticked — an empty
 * "0 selected" panel above every visit would be noise on the far more common
 * single-item path.
 */
(function () {
  var form = document.getElementById('bulkRequest');
  if (!form) return;

  var count = document.getElementById('bulkCount');
  var clear = document.getElementById('bulkClear');
  var ticks = function () { return document.querySelectorAll('.bulk-tick'); };

  function refresh() {
    var chosen = 0;
    ticks().forEach(function (t) {
      if (t.checked) chosen++;
      var card = t.closest('.item-card');
      if (card) card.classList.toggle('is-picked', t.checked);
    });
    count.textContent = chosen;
    form.hidden = chosen === 0;
  }

  document.addEventListener('change', function (e) {
    if (e.target.classList && e.target.classList.contains('bulk-tick')) refresh();
  });

  clear.addEventListener('click', function () {
    ticks().forEach(function (t) { t.checked = false; });
    refresh();
  });

  refresh();
})();

/**
 * Deciding several requests at once, on the admin Requests page.
 *
 * The batch buttons further down that page handle one person's basket. This
 * handles a whole morning's queue: tick anything, from any number of people,
 * and approve or decline the lot.
 *
 * The bar stays hidden until something is ticked, so the far more common
 * single-decision path is not made to read around an empty toolbar.
 */
(function () {
  var form = document.getElementById('bulkDecide');
  if (!form) return;

  var count = document.getElementById('pickCount');
  var people = document.getElementById('pickPeople');
  var clear = document.getElementById('pickClear');

  var ticks = function () { return Array.prototype.slice.call(document.querySelectorAll('.pick-tick')); };
  var chosen = function () { return ticks().filter(function (t) { return t.checked; }); };

  function refresh() {
    var picked = chosen();

    ticks().forEach(function (t) {
      var card = t.closest('.request-card');
      if (card) card.classList.toggle('is-picked', t.checked);
    });

    count.textContent = picked.length;

    // Naming how many people are affected, because approving nine requests
    // across four people is a bigger act than approving one person's four
    var names = {};
    picked.forEach(function (t) { names[t.getAttribute('data-user')] = true; });
    var howMany = Object.keys(names).length;
    people.textContent = howMany > 1 ? ' across ' + howMany + ' people' : '';

    form.hidden = picked.length === 0;

    // Keep each select-all honest about what is under it
    document.querySelectorAll('.pick-all').forEach(function (box) {
      var scope = scopeTicks(box.getAttribute('data-scope'));
      var on = scope.filter(function (t) { return t.checked; }).length;
      box.checked = scope.length > 0 && on === scope.length;
      box.indeterminate = on > 0 && on < scope.length;
    });
  }

  function scopeTicks(scope) {
    if (scope === 'all') return ticks();
    var group = document.querySelector('[data-batch="' + scope + '"]');
    return group ? Array.prototype.slice.call(group.querySelectorAll('.pick-tick')) : [];
  }

  document.addEventListener('change', function (e) {
    if (e.target.classList && e.target.classList.contains('pick-tick')) return refresh();

    if (e.target.classList && e.target.classList.contains('pick-all')) {
      var on = e.target.checked;
      scopeTicks(e.target.getAttribute('data-scope')).forEach(function (t) { t.checked = on; });
      refresh();
    }
  });

  clear.addEventListener('click', function () {
    ticks().forEach(function (t) { t.checked = false; });
    refresh();
  });

  /**
   * Declining asks for a note first; approving does not. The prompt has to
   * know which button was pressed, so it reads the submitter rather than
   * assuming — a shared data-note on the form would interrogate people who
   * only meant to approve.
   */
  form.addEventListener('submit', function (e) {
    var action = e.submitter ? e.submitter.value : 'approve';
    var picked = chosen();

    if (action === 'reject') {
      var note = window.prompt(
        'Declining ' + picked.length + ' request(s). Add a note for them (optional):',
        ''
      );
      if (note === null) { e.preventDefault(); return; }
      form.querySelector('input[name="note"]').value = note;
    } else if (picked.length > 3) {
      // A quiet double-check on the sweeping ones only
      if (!window.confirm('Approve ' + picked.length + ' requests?')) e.preventDefault();
    }
  });

  refresh();
})();
