(() => {
  const root = document.documentElement;
  const initial = new URL(location.href).searchParams.get('design');
  root.dataset.adminDesign = initial === 'a' ? 'a' : 'current';

  function showDesign(design) {
    const isDesignA = design === 'a';
    root.dataset.adminDesign = isDesignA ? 'a' : 'current';
    document.querySelectorAll('[data-admin-design-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.adminDesignChoice === root.dataset.adminDesign));
    });
    document.querySelectorAll('.admin-bar-link, .breadcrumb a').forEach(link => {
      link.href = isDesignA ? 'design-a.html' : 'index.html';
      link.textContent = isDesignA ? 'A案のサイトを見る' : 'サイトを見る';
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    showDesign(root.dataset.adminDesign);
    document.querySelectorAll('[data-admin-design-choice]').forEach(button => {
      button.addEventListener('click', () => {
        showDesign(button.dataset.adminDesignChoice);
        const address = new URL(location.href);
        if (root.dataset.adminDesign === 'a') address.searchParams.set('design', 'a');
        else address.searchParams.delete('design');
        try { history.replaceState(null, '', address); } catch {}
      });
    });
  });
})();
