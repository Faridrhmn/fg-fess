/**
 * room-nav.js
 * Handles Room Selector Dropdown, User Profile Menu, and Create Room Modal globally
 */

window.currentAuthMode = 'register';

function toggleRoomDropdown(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const menu = document.getElementById('roomDropdownMenu');
  const btn = document.getElementById('roomSelectorBtn');
  if (!menu) return;

  const isOpen = menu.classList.contains('show');
  closeAllDropdowns();

  if (!isOpen) {
    menu.classList.add('show');
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
    }
    const searchInput = document.getElementById('globalRoomSearchInput');
    if (searchInput) {
      setTimeout(() => searchInput.focus(), 50);
    }
  }
}

function closeRoomDropdown() {
  const menu = document.getElementById('roomDropdownMenu');
  const btn = document.getElementById('roomSelectorBtn');
  if (menu) menu.classList.remove('show');
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
}

function toggleUserDropdown(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const menu = document.getElementById('userDropdownMenu');
  const btn = document.getElementById('userMenuBtn');
  if (!menu) return;

  const isOpen = menu.classList.contains('show');
  closeAllDropdowns();

  if (!isOpen) {
    menu.classList.add('show');
    if (btn) {
      btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
    }
  }
}

function closeUserDropdown() {
  const menu = document.getElementById('userDropdownMenu');
  const btn = document.getElementById('userMenuBtn');
  if (menu) menu.classList.remove('show');
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
}

function closeAllDropdowns() {
  closeRoomDropdown();
  closeUserDropdown();
}

// Global click-outside dismissal
document.addEventListener('click', (e) => {
  const roomWrapper = document.getElementById('roomSelectorWrapper');
  const userWrapper = document.getElementById('userMenuWrapper');

  if (roomWrapper && !roomWrapper.contains(e.target)) {
    closeRoomDropdown();
  }
  if (userWrapper && !userWrapper.contains(e.target)) {
    closeUserDropdown();
  }
});

// ESC key closes dropdowns and modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllDropdowns();
    closeCreateRoomModal();
  }
});

function filterGlobalRoomList(query) {
  const q = query.trim().toLowerCase();
  const items = document.querySelectorAll('.room-dropdown-item');
  let matchCount = 0;

  items.forEach(item => {
    const name = item.getAttribute('data-room-name') || '';
    const slug = item.getAttribute('data-room-slug') || '';
    if (!q || name.includes(q) || slug.includes(q)) {
      item.style.display = 'flex';
      matchCount++;
    } else {
      item.style.display = 'none';
    }
  });

  const emptyEl = document.getElementById('roomDropdownEmpty');
  if (emptyEl) {
    emptyEl.style.display = matchCount === 0 ? 'block' : 'none';
  }
}

// ─── Modal Buat Room ──────────────────────────────────────────────────────────

function openCreateRoomModal() {
  closeAllDropdowns();
  const modal = document.getElementById('createRoomModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const err = document.getElementById('createRoomError');
  if (err) err.style.display = 'none';
  const nameInput = document.getElementById('cr_name');
  if (nameInput) {
    setTimeout(() => nameInput.focus(), 50);
  }
}

function closeCreateRoomModal() {
  const modal = document.getElementById('createRoomModal');
  if (modal) modal.classList.add('hidden');
}

function autoGenerateSlug(name) {
  const slugInput = document.getElementById('cr_slug');
  if (!slugInput) return;
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  slugInput.value = slug;
}

function togglePrivatePasscode(isPrivate) {
  const container = document.getElementById('cr_passcode_container');
  const input = document.getElementById('cr_passcode');
  if (container) {
    container.style.display = isPrivate ? 'block' : 'none';
  }
  if (input) {
    input.required = isPrivate;
    if (isPrivate) input.focus();
  }
}

function switchAuthTab(mode) {
  window.currentAuthMode = mode;
  const tabReg = document.getElementById('tabRegisterBtn');
  const tabLogin = document.getElementById('tabLoginBtn');
  const hint = document.getElementById('authModeHint');

  if (mode === 'register') {
    if (tabReg) { tabReg.style.background = 'var(--surface)'; tabReg.style.color = 'var(--text)'; }
    if (tabLogin) { tabLogin.style.background = 'none'; tabLogin.style.color = 'var(--text-muted)'; }
    if (hint) hint.textContent = 'Akun ini akan otomatis dibuat & menjadi pemilik room untuk moderasi.';
  } else {
    if (tabLogin) { tabLogin.style.background = 'var(--surface)'; tabLogin.style.color = 'var(--text)'; }
    if (tabReg) { tabReg.style.background = 'none'; tabReg.style.color = 'var(--text-muted)'; }
    if (hint) hint.textContent = 'Masukkan username & password akun admin yang sudah kamu daftarkan sebelumnya.';
  }
}

async function handleCreateRoomSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('createRoomError');
  const submitBtn = document.getElementById('btnSubmitCreateRoom');
  if (errEl) errEl.style.display = 'none';

  const name = document.getElementById('cr_name').value.trim();
  const slug = document.getElementById('cr_slug').value.trim().toLowerCase();
  const desc = document.getElementById('cr_desc').value.trim();
  const isPrivate = document.getElementById('cr_is_private').checked;
  const passcode = isPrivate ? (document.getElementById('cr_passcode').value || '').trim() : '';

  const usernameInput = document.getElementById('cr_username');
  const passwordInput = document.getElementById('cr_password');
  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (isPrivate && !passcode) {
    showCreateRoomError('Private room wajib memiliki Visitor Passcode!');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Membuat Room…';
  }

  try {
    const payload = {
      name: name,
      slug: slug,
      description: desc,
      is_private: isPrivate,
      visitor_passcode: passcode,
      auth_mode: window.currentAuthMode,
      username: username,
      password: password
    };

    const res = await fetch('/api/rooms/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      showCreateRoomError(data.error || 'Gagal membuat room.');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Buat Room Sekarang';
      }
      return;
    }

    // Success -> redirect to the newly created room
    window.location.href = data.redirect_url || data.redirect || `/r/${slug}`;
  } catch (err) {
    showCreateRoomError('Terjadi kesalahan jaringan.');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Buat Room Sekarang';
    }
  }
}

function showCreateRoomError(msg) {
  const errEl = document.getElementById('createRoomError');
  if (errEl) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  } else {
    alert(msg);
  }
}
