const loginButton = document.querySelector('#google-login');
const retryConnectionButton = document.querySelector('#retry-connection');
const retryAccessButton = document.querySelector('#retry-access');
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
let initialAdminData = null;
const requests = new Set();
const AUTH_SETTINGS = SALON.adminAuth || { requestTimeoutMs: 30000, popupWaitNoticeMs: 15000 };

function showError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function closeAdmin() {
  generation += 1;
  initialAdminData = null;
  retryAccessButton.hidden = true;
  for (const request of requests) request.abort();
  frame.removeAttribute('src');
  managementView.hidden = true;
  loginView.hidden = false;
  document.documentElement.classList.remove('is-managing');
  loginButton.disabled = !auth;
}

function showAdmin(result) {
  initialAdminData = result;
  loginError.hidden = true;
  loginView.hidden = true;
  managementView.hidden = false;
  document.documentElement.classList.add('is-managing');
  document.querySelector('#account-label').textContent = user.email || '管理者';
  frame.src = 'admin.html?design=a&google=1&v=20260929-confirm';
}

async function post(body, signal) {
  const response = await fetch(SALON.reservationEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body), cache: 'no-store', signal
  });
  if (!response.ok) throw Object.assign(new Error(), { httpStatus: response.status });
  const result = await response.json();
  if (!result || typeof result.ok !== 'boolean') throw new Error();
  return result;
}

async function withRequestTimeout(operation) {
  const controller = new AbortController();
  requests.add(controller);
  let timeout;
  const expired = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(), { name: 'AbortError' }));
    }, AUTH_SETTINGS.requestTimeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { clearTimeout(timeout); requests.delete(controller); }
}

function connectionDetail(error) {
  if (Number.isInteger(error?.httpStatus)) return `（HTTP ${error.httpStatus}）`;
  return error?.name === 'AbortError' ? '（待ち時間の上限に達しました）' : '';
}

window.authAdminRequest = async payload => {
  const unknown = { ok: false, transportError: true,
    error: '管理操作の結果を確認できません。再ログイン後、台帳の内容を確認してください。自動では再送しません。' };
  if (!user || !payload || !actions.has(payload.type)) return unknown;
  if (payload.type === 'adminData' && Object.keys(payload).length === 1 && initialAdminData) {
    const result = initialAdminData;
    initialAdminData = null;
    return result;
  }
  const attempt = generation;
  try {
    const result = await withRequestTimeout(async signal => {
      const idToken = await user.getIdToken();
      if (signal.aborted || attempt !== generation) return unknown;
      const { type: action, ...rest } = payload;
      return post({ type: 'googleAdmin', action, payload: rest, idToken }, signal);
    });
    if (attempt !== generation) return unknown;
    if (result.authDenied) {
      closeAdmin();
      user = null;
      await sdk.signOut(auth);
      showError(result.error || '管理権限を確認できません。もう一度ログインしてください。');
      return { ok: false, authDenied: true, error: result.error };
    }
    return result;
  } catch (error) {
    const retryLabel = managementView.hidden ? '台帳をもう一度読み込む' : '最新の予定を読み込む';
    return payload.type === 'adminData' ? { ...unknown,
      error: `台帳の読込結果を確認できません${connectionDetail(error)}。通信の問題の可能性があります。「${retryLabel}」で再確認してください。` } : unknown;
  }
};

async function loadAdmin() {
  loginStatus.textContent = 'Googleのアカウント選択は完了しました。管理権限と台帳を確認しています。';
  const result = await window.authAdminRequest({ type: 'adminData' });
  if (result.ok) {
    showAdmin(result);
    return;
  }
  if (!result.transportError && user) {
    user = null;
    await sdk.signOut(auth);
  }
  retryAccessButton.hidden = !user;
  loginStatus.textContent = user ? 'Googleのアカウント選択は完了しています。台帳の読込は未完了です。'
    : '管理者のGoogleアカウントでログインしてください。';
  showError(result.error || '管理権限を確認できません。');
}

async function signIn() {
  if (!auth || busy) return;
  busy = true;
  loginButton.disabled = true;
  retryAccessButton.hidden = true;
  initialAdminData = null;
  user = null;
  loginError.hidden = true;
  loginStatus.textContent = 'Googleでアカウントを選んでください。';
  const waitNotice = setTimeout(() => {
    if (!user && busy) showError('Googleからログイン結果がまだ戻っていません。白い小窓だけが残る場合は小窓を閉じ、通常のChromeかSafariでこのページを開いてください。');
  }, AUTH_SETTINGS.popupWaitNoticeMs);
  try {
    const provider = new sdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    user = (await sdk.signInWithPopup(auth, provider)).user;
    clearTimeout(waitNotice);
    loginError.hidden = true;
    await loadAdmin();
  } catch (error) {
    user = null;
    loginStatus.textContent = 'まだログインしていません。';
    showError(error?.code === 'auth/popup-blocked'
      ? 'Googleの画面を開けません。このサイトのポップアップを許可し、ChromeかSafariでお試しください。'
      : 'Googleログインを完了できませんでした。通信とアカウントをご確認ください。');
  } finally {
    clearTimeout(waitNotice);
    busy = false;
    loginButton.disabled = !auth;
  }
}

loginButton.addEventListener('click', signIn);
retryAccessButton.addEventListener('click', async () => {
  if (!user || busy) return;
  busy = true;
  retryAccessButton.disabled = true;
  loginButton.disabled = true;
  loginError.hidden = true;
  try { await loadAdmin(); }
  finally {
    busy = false;
    retryAccessButton.disabled = false;
    loginButton.disabled = !auth;
  }
});
logoutButton.addEventListener('click', async () => {
  if (busy) return;
  if (frame.contentWindow?.authDemoHasUnsaved?.()
      && !confirm('書きかけの入力があります。ログアウトしてよろしいですか？')) return;
  busy = true;
  closeAdmin();
  user = null;
  loginButton.disabled = true;
  loginError.hidden = true;
  loginStatus.textContent = 'ログアウトしています。';
  try {
    await sdk.signOut(auth);
    loginStatus.textContent = '管理者のGoogleアカウントでログインしてください。';
  } catch {
    loginStatus.textContent = '管理画面を閉じました。';
    showError('ログアウトを確認できません。ページを閉じてください。');
  } finally {
    busy = false;
    loginButton.disabled = !auth;
  }
});

async function setupAuth() {
  if (busy || auth) return;
  busy = true;
  retryConnectionButton.hidden = true;
  loginError.hidden = true;
  loginStatus.textContent = '接続を確認しています。';
  try {
    await withRequestTimeout(async signal => {
      const result = await post({ type: 'adminAuthConfig' }, signal);
      if (!result.ok || !result.firebase) throw new Error();
      const [appSdk, authSdk] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js')
      ]);
      if (signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });
      sdk = authSdk;
      auth = sdk.initializeAuth(appSdk.initializeApp(result.firebase), {
        persistence: sdk.inMemoryPersistence, popupRedirectResolver: sdk.browserPopupRedirectResolver
      });
    });
    loginStatus.textContent = '管理者のGoogleアカウントでログインしてください。';
    loginButton.disabled = false;
  } catch (error) {
    loginStatus.textContent = '管理画面への接続を確認できませんでした。';
    showError(`接続設定または通信を確認できません${connectionDetail(error)}。「接続をもう一度確認」で再確認してください。予約の受付状況とは別です。`);
    retryConnectionButton.hidden = false;
  } finally { busy = false; }
}

retryConnectionButton.addEventListener('click', setupAuth);
await setupAuth();
