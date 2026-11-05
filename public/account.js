// Account controls live outside gameplay. Profile changes apply on the next join.
export function accountUI({ room, read, fill }) {
  const box = document.getElementById('accountBox');
  const note = document.getElementById('accountNote');
  const login = document.getElementById('googleLogin');
  const logout = document.getElementById('accountLogout');
  const save = document.getElementById('characterSave');
  const restore = document.getElementById('characterRestore');
  const join = document.getElementById('joinBtn');
  let state = null, character = null, loadedRoom = null, busy = false;
  const guestNote = 'Chơi khách không bảo đảm giữ nhân vật. Đăng nhập Google để lưu nhân vật và dùng trên thiết bị khác.';
  const scoreNote = 'Điểm chưa được lưu lâu dài và chưa chuyển từ khách sang tài khoản.';
  async function api(path, options = {}) {
    const r = await fetch(path, { cache: 'no-store', ...options });
    const body = await r.json();
    if (!r.ok) throw Error(body.error || 'Chưa tải được hồ sơ. Thử lại nhé.');
    return body;
  }
  function render() {
    box.hidden = false;
    login.hidden = !state?.enabled || !!state.authenticated;
    save.hidden = restore.hidden = !state?.authenticated;
    logout.hidden = !state?.authenticated && !state?.expired;
    join.textContent = state?.authenticated ? 'Vào văn phòng' : 'Chơi khách';
    save.textContent = character ? 'Lưu chỉnh sửa' : 'Tạo nhân vật từ hồ sơ này';
    restore.textContent = 'Khôi phục hồ sơ';
    note.textContent = state?.authenticated ? ('Đã đăng nhập Google. ' + (character ? 'Nhân vật của phòng đã được khôi phục. ' : 'Phòng này chưa có nhân vật. Kiểm tra hồ sơ rồi bấm tạo. ') + scoreNote) : guestNote + ' ' + scoreNote;
  }
  async function loadProfile() {
    if (!state?.authenticated) return;
    busy = true;
    try {
      const selected = room();
      const data = await api('/api/profile?room=' + encodeURIComponent(selected));
      if (selected !== room()) return;
      character = data.character; loadedRoom = selected;
      if (character) fill(character);
      render();
    } catch (e) { loadedRoom = null; note.textContent = e.message; }
    finally { busy = false; }
  }
  async function init() {
    try { state = await api('/api/auth/status'); if (state.authenticated) document.documentElement.classList.remove('autojoin'); render(); await loadProfile(); if (new URLSearchParams(location.search).has('error')) note.textContent = 'Chưa đăng nhập được. Thử lại sau nhé; bạn vẫn có thể chọn chơi khách.'; }
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
  restore.addEventListener('click', loadProfile);
  save.addEventListener('click', async () => {
    if (busy) return;
    if (loadedRoom !== room()) { await loadProfile(); return; }
    busy = true; save.disabled = true;
    try {
      const data = await api('/api/profile?room=' + encodeURIComponent(room()), { method: character ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read()) });
      character = data.character; fill(character); render();
      note.textContent = 'Đã lưu nhân vật. Thay đổi áp dụng khi vào phòng tiếp theo. ' + scoreNote;
    } catch (e) { note.textContent = e.message; }
    finally { busy = false; save.disabled = false; }
  });
  const ready = init();
  return {
    ready,
    roomChanged() { loadedRoom = null; character = null; loadProfile(); },
    async beforeJoin() {
      await ready;
      if (state?.expired) throw Error('Phiên cũ đã hết hạn. Đăng xuất để chơi khách hoặc đăng nhập Google lại nhé.');
      if (state?.authenticated && (busy || loadedRoom !== room() || !character)) throw Error('Khôi phục hoặc tạo nhân vật cho phòng này trước khi vào nhé.');
      if (character && state?.authenticated) fill(character);
    },
    authenticated: () => !!state?.authenticated,
  };
}
