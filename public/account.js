// Account controls live outside gameplay. Profile changes apply on the next join.
export function accountUI({ room, read, fill }) {
  const box = document.getElementById('accountBox');
  const note = document.getElementById('accountNote');
  const login = document.getElementById('googleLogin');
  const logout = document.getElementById('accountLogout');
  const save = document.getElementById('characterSave');
  const restore = document.getElementById('characterRestore');
  const join = document.getElementById('joinBtn');
  const status = document.getElementById('accountStatus');
  const fields = document.querySelectorAll('.joinFields input, .joinFields select');
  const editor = document.getElementById('characterEditor');
  const summary = document.getElementById('characterSummary');
  let state = null, character = null, loadedRoom = null, busy = false, editing = false, profileError = false, loadVersion = 0;
  const guestNote = 'Chơi không đăng nhập không bảo đảm giữ nhân vật hay điểm. Đăng nhập Google để lưu nhân vật, dùng trên thiết bị khác và nhận điểm hôm nay của tab này.';
  async function api(path, options = {}) {
    const r = await fetch(path, { cache: 'no-store', ...options });
    const body = await r.json();
    if (!r.ok) throw Error(body.error || 'Chưa tải được hồ sơ. Thử lại nhé.');
    return body;
  }
  function render() {
    box.hidden = false;
    status.hidden = !state?.authenticated;
    login.hidden = !state?.enabled || !!state.authenticated;
    save.hidden = !state?.authenticated || !character || editing || busy || profileError;
    restore.hidden = !state?.authenticated || (!editing && !profileError);
    logout.hidden = !state?.authenticated && !state?.expired;
    save.textContent = 'Sửa nhân vật';
    restore.textContent = profileError ? 'Thử tải lại' : 'Hủy chỉnh sửa';
    join.textContent = !state?.authenticated ? 'Vào chơi ngay' : busy ? 'Đang tải…' : !character ? 'Tạo nhân vật & vào phòng' : editing ? 'Lưu & vào phòng' : 'Vào văn phòng';
    join.dataset.accountBusy = String(busy || profileError);
    const readOnly = !!state?.authenticated && !!character && !editing;
    editor.hidden = readOnly; summary.hidden = !readOnly;
    document.querySelector('.joinFields').setAttribute('aria-busy', String(busy));
    if (readOnly) {
      document.getElementById('summaryName').textContent = character.name;
      const company = document.getElementById('summaryCompany');
      company.textContent = character.company || 'Chưa thêm'; company.classList.toggle('is-empty', !character.company);
      const options = document.getElementById('roleSelect').options;
      document.getElementById('summaryRole').textContent = [...options].find(o=>o.value===character.role)?.textContent.trim() || character.role;
      document.getElementById('summaryGender').textContent = character.gender === 'f' ? 'Nữ' : 'Nam';
    }
    for (const field of fields) field.disabled = !!state?.authenticated && (busy || (!!character && !editing));
    if (busy || profileError) join.disabled = true;
    else document.getElementById('nameInput').dispatchEvent(new Event('input'));
    if (profileError) return;
    note.textContent = !state?.authenticated ? guestNote : busy ? 'Đang tải nhân vật của phòng…' : !character
      ? 'Bạn chưa có nhân vật ở phòng này. Điền thông tin rồi bấm “Tạo nhân vật & vào phòng”.'
      : editing ? 'Chỉnh thông tin rồi bấm “Lưu & vào phòng”.'
      : 'Nhân vật đã sẵn sàng. Chọn phòng rồi bấm “Vào văn phòng”.';
  }
  async function loadProfile() {
    if (!state?.authenticated) return;
    const version = ++loadVersion;
    const selected = room();
    busy = true; editing = false; profileError = false; render();
    try {
      const data = await api('/api/profile?room=' + encodeURIComponent(selected));
      if (version !== loadVersion || selected !== room()) return;
      character = data.character; loadedRoom = selected;
      if (character) fill(character);
    } catch (e) {
      if (version !== loadVersion) return;
      loadedRoom = null; profileError = true; note.textContent = e.message;
    } finally { if (version === loadVersion) { busy = false; render(); } }
  }
  async function init() {
    try { state = await api('/api/auth/status'); render(); await loadProfile(); if (new URLSearchParams(location.search).has('error')) note.textContent = 'Chưa đăng nhập được. Thử lại sau nhé; bạn vẫn có thể vào chơi ngay không cần đăng nhập.'; }
    catch (e) { note.textContent = e.message; box.hidden = false; }
  }
  async function authAction(action) {
    // Auth.js issues and checks its own CSRF cookie/token for sign-in and sign-out.
    const { csrfToken } = await api('/api/auth/csrf');
    const form = document.createElement('form');
    form.method = 'POST'; form.action = '/api/auth/' + action;
    for (const [name, value] of Object.entries({ csrfToken, callbackUrl: location.origin + '/?room=' + encodeURIComponent(room()) })) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
    }
    sessionStorage.removeItem('br-auto');
    document.body.append(form); form.submit();
  }
  login.addEventListener('click', () => authAction('signin/google').catch(e => { note.textContent = e.message; }));
  logout.addEventListener('click', () => authAction('signout').catch(e => { note.textContent = e.message; }));
  restore.addEventListener('click', () => {
    if (profileError) { loadProfile(); return; }
    editing = false; if (character) fill(character); render(); save.focus();
  });
  save.addEventListener('click', () => {
    if (busy || !character) return;
    editing = true; render(); document.getElementById('nameInput').focus();
  });
  const ready = init();
  return {
    ready,
    roomChanged() { loadedRoom = null; character = null; editing = false; loadProfile(); },
    async beforeJoin() {
      await ready;
      if (state?.expired) throw Error('Phiên cũ đã hết hạn. Đăng xuất để chơi không cần đăng nhập hoặc đăng nhập Google lại nhé.');
      if (!state?.authenticated) return;
      if (busy || loadedRoom !== room() || profileError) throw Error('Chưa tải được nhân vật. Bấm “Thử tải lại” nhé.');
      if (!character || editing) {
        const selected = room();
        const input = read();
        busy = true; render();
        try {
          const data = await api('/api/profile?room=' + encodeURIComponent(selected), {
            method: character ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
          });
          if (selected !== room()) throw Error('Phòng đã thay đổi. Kiểm tra nhân vật trước khi vào nhé.');
          character = data.character; editing = false; fill(character);
        } finally { busy = false; render(); }
      }
      fill(character);
    },
    authenticated: () => !!state?.authenticated,
  };
}
