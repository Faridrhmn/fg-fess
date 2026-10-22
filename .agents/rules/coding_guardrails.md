# Guardrails Arsitektur & Pola Pengembangan (Confess / FG-Fess)

Dokumen ini adalah acuan standar wajib (*guardrails*) untuk setiap update, refactoring, perbaikan bug, atau penambahan fitur di codebase ini. Tujuannya adalah menjaga konsistensi gaya, UI/UX, dan mencegah bug berulang (terutama terkait pemuatan pesan dan modal).

---

## 1. Konsistensi UI/UX: Modal & Notifikasi (Dilarang Native Browser Dialog)
- **DILARANG KERAS** menggunakan dialog bawaan browser: `alert()`, `confirm()`, atau `prompt()`. Dialog native memunculkan popup bar mengambang di atas browser yang tidak seragam dan mengganggu estetika antarmuka.
- **WAJIB** menggunakan komponen modal konfirmasi terstandarisasi (`.confirm-overlay` dan `.confirm-box`):
  ```javascript
  const confirmed = await showConfirm({
    title: 'Konfirmasi Aksi',
    message: 'Apakah Anda yakin ingin melanjutkan?',
    icon: '⚠️', // atau '🗑️', '🚫', '✓'
    okText: 'Ya, Lanjutkan',
    cancelText: 'Batal',
    okDanger: true // true = tombol merah (destructive), false = tombol warna primer
  });
  if (!confirmed) return;
  ```
- **WAJIB** menggunakan `showToast(msg, type)` untuk umpan balik aksi (sukses, error, info), bukan alert:
  ```javascript
  showToast('Perubahan berhasil disimpan.', 'success');
  showToast('Terjadi kesalahan jaringan.', 'error');
  ```

---

## 2. Load Message & Room State Scoping (Mencegah Kebocoran Pesan Lintas Room)
Setiap kali ada pembaruan pada alur feed pesan, REST API, polling, atau pagination, aturan berikut **wajib dipatuhi**:

### A. Admin Dashboard Messages Polling
- Polling `setInterval` di `templates/admin.html` wajib membaca URL query parameters:
  ```javascript
  const urlParams = new URLSearchParams(window.location.search);
  const filterMode = urlParams.get('filter') || 'all';
  const roomFilter = urlParams.get('room') || 'all';
  ```
- Endpoint fetch wajib selalu mengirimkan kedua parameter tersebut:
  ```javascript
  fetch(`/api/admin/messages?since=${latestId}&filter=${encodeURIComponent(filterMode)}&room=${encodeURIComponent(roomFilter)}`)
  ```
- Backend `@app.route('/api/admin/messages')` di `app.py` wajib menerapkan filter `room_filter`:
  ```python
  if room_filter != 'all':
      query = query.join(Room).filter(Room.slug == room_filter)
  ```
- Tautan pagination di `templates/admin.html` wajib mempertahankan `&room={{ room_filter }}` agar tidak me-reset filter room saat berpindah halaman.

### B. Public Feed & Socket.IO
- Pengiriman pesan anonim (`submitMessage()`) wajib menyertakan `room_slug`:
  ```javascript
  if (window.CURRENT_ROOM_SLUG) {
    formData.append('room_slug', window.CURRENT_ROOM_SLUG);
  }
  ```
- Socket.IO saat `connect` wajib memicu `join_room`:
  ```javascript
  const currentRoom = window.CURRENT_ROOM_SLUG || 'general';
  socket.emit('join_room', { room: currentRoom });
  ```
- Sinkronisasi reconnect (state healing) wajib menyertakan parameter `room`:
  ```javascript
  fetch(`/api/messages?since=${latestId}&room=${encodeURIComponent(currentRoom)}`)
  ```
- Handler `new_message` Socket.IO di frontend wajib memastikan `msg.room_slug` cocok dengan `window.CURRENT_ROOM_SLUG` sebelum pesan di-injeksi ke DOM.

---

## 3. Integritas Skrip & Event Handlers
- **Aset Utama Tidak Boleh Kosong:** `static/script.js`, `static/room-nav.js`, dan `static/style.css` berisi fungsi interaktif vital (`submitMessage`, reaksi emoji, polling, formatting teks, share dialog, dll). Dilarang mengosongkan atau mengganti file tanpa memastikan seluruh fungsinya tetap tersedia.
- **Deklarasi Fungsi Inline:** Setiap kali sebuah tombol atau elemen template menggunakan inline event handler (contoh: `onclick="openRoomSettingsModal()"`), fungsi tersebut **wajib** didefinisikan secara global pada file skrip terkait dan tidak boleh ditinggalkan tanpa implementasi (`ReferenceError`).
- **Pembersihan Modal & ESC Handler:** Semua modal overlay wajib dapat ditutup dengan tombol Close, klik di luar kartu (`backdrop click`), dan tombol keyboard `Escape`.
