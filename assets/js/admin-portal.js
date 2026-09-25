const loginButton = document.querySelector('#google-login');
const logoutButton = document.querySelector('#google-logout');
const loginStatus = document.querySelector('#login-status');
const loginError = document.querySelector('#login-error');
const frame = document.querySelector('#admin-frame');
const managementView = document.querySelector('#management-view');
const loginView = document.querySelector('#login-view');
const actions = new Set(['adminData', 'adminSave', 'adminUpload', 'adminAdd',
  'adminAddStatus', 'adminNote', 'adminChange', 'cancel']);
let auth;
let sdk;
let user;
let busy = false;
let generation = 0;
const requests = new Set();

function showError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function closeAdmin() {
  generation += 1;
  for (const request of requests) request.abort();
  frame.removeAttribute('src');
  managementView.hidden = true;
  loginView.hidden = false;
  document.documentElement.classList.remove('is-managing');
  loginButton.disabled = !auth;
}

function showAdmin() {
  loginError.hidden = true;
  loginView.hidden = true;
  managementView.hidden = false;
  document.documentElement.classList.add('is-managing');
  document.querySelector('#account-label').textContent = user.email || '管理者';
  frame.src = 'admin.html?design=a&google=1';
}

async function post(body, signal) {
  const response = await fetch(SALON.reservationEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body), cache: 'no-store', signal
  });
  if (!response.ok) throw new Error();
  const result = await response.json();
  if (!result || typeof result.ok !== 'boolean') throw new Error();
  return result;
}

window.authAdminRequest = async payload => {
  const unknown = { ok: false, transportError: true,
    error: '管理操作の結果を確認できません。再ログイン後、台帳の内容を確認してください。自動では再送しません。' };
  if (!user || !payload || !actions.has(payload.type)) return unknown;
  const attempt = generation;
  const controller = new AbortController();
  requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const idToken = await user.getIdToken();
    if (controller.signal.aborted || attempt !== generation) return unknown;
    const { type: action, ...rest } = payload;
    const result = await post({ type: 'googleAdmin', action, payload: rest, idToken }, controller.signal);
    if (attempt !== generation) return unknown;
    if (result.authDenied) {
      closeAdmin();
      user = null;
      await sdk.signOut(auth);
      showError(result.error || '管理権限を確認できません。もう一度ログインしてください。');
      return { ok: false, authDenied: true, error: result.error };
    }
    return result;
  } catch { return unknown; }
  finally { clearTimeout(timeout); requests.delete(controller); }
};

async function signIn() {
  if (!auth || busy) return;
  busy = true;
  loginButton.disabled = true;
  loginError.hidden = true;
  loginStatus.textContent = 'Googleでアカウントを選んでください。';
  try {
    const provider = new sdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    user = (await sdk.signInWithPopup(auth, provider)).user;
    loginStatus.textContent = '管理権限と台帳の接続を確認しています。';
    const result = await window.authAdminRequest({ type: 'adminData' });
    if (!result.ok) {
      user = null;
      await sdk.signOut(auth);
      showError(result.error || '管理権限を確認できません。');
      return;
    }
    showAdmin();
  } catch (error) {
    user = null;
    showError(error?.code === 'auth/popup-blocked'
      ? 'Googleの画面を開けません。このサイトのポップアップを許可し、ChromeかSafariでお試しください。'
      : 'Googleログインを完了できませんでした。通信とアカウントをご確認ください。');
  } finally {
    busy = false;
    loginButton.disabled = !auth;
    loginStatus.textContent = '管理者のGoogleアカウントでログインしてください。';
  }
}

loginButton.addEventListener('click', signIn);
logoutButton.addEventListener('click', async () => {
  if (frame.contentWindow?.authDemoHasUnsaved?.()
      && !confirm('書きかけの入力があります。ログアウトしてよろしいですか？')) return;
  closeAdmin();
  user = null;
  try { await sdk.signOut(auth); } catch { showError('ログアウトを確認できません。ページを閉じてください。'); }
});

try {
  const result = await post({ type: 'adminAuthConfig' });
  if (!result.ok || !result.firebase) throw new Error();
  const appSdk = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js');
  sdk = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js');
  auth = sdk.initializeAuth(appSdk.initializeApp(result.firebase), {
    persistence: sdk.inMemoryPersistence, popupRedirectResolver: sdk.browserPopupRedirectResolver
  });
  loginStatus.textContent = '管理者のGoogleアカウントでログインしてください。';
  loginButton.disabled = false;
} catch {
  loginStatus.textContent = '管理画面の接続はまだ利用できません。';
  showError('Google管理者の設定または通信を確認できません。予約の受付状況とは別です。');
}
