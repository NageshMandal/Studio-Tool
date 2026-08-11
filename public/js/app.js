// Clear the ?message= flag from the URL so a refresh does not repeat the banner
(function () {
  var url = new URL(window.location.href);
  if (url.searchParams.has('message')) {
    url.searchParams.delete('message');
    window.history.replaceState({}, '', url.pathname + (url.search || ''));
  }

  var alerts = document.querySelectorAll('.alert-info');
  alerts.forEach(function (el) {
    setTimeout(function () {
      el.remove();
    }, 4000);
  });
})();

// Live preview for the instrument image URL on the product form
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
})();
