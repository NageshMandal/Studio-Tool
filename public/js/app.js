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
