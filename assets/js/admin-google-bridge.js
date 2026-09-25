(() => {
  if (window.parent === window || new URL(location.href).searchParams.get('google') !== '1'
      || typeof window.parent.authAdminRequest !== 'function') return;
  window.googleAdminEmbedded = true;
  adminPost = payload => window.parent.authAdminRequest(payload);
  window.authDemoHasUnsaved = () => {
    const event = new Event('beforeunload', { cancelable: true });
    warnBeforeLeaving(event);
    return event.defaultPrevented;
  };

  document.addEventListener('DOMContentLoaded', async () => {
    document.querySelector('#gate').hidden = true;
    document.querySelector('#forget-device').hidden = true;
    document.querySelector('#site-header').hidden = true;
    document.querySelector('#site-footer').hidden = true;
    document.querySelector('.breadcrumb').hidden = true;
    document.querySelector('.admin-design-review').hidden = true;
    if (!(await openDashboard())) {
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = '予定を読み込めませんでした。ログインし直してから、台帳の内容をご確認ください。';
      document.querySelector('main').prepend(message);
    }
  });
})();
