# Coding Guardrails & Standards — Confess (FG-Fess)

Dokumentasi ini adalah aturan acuan (*guardrails*) untuk pengembangan, refactoring, dan perbaikan fitur di repositori ini.

Detail lengkap guardrails dapat dilihat pada [.agents/rules/coding_guardrails.md](file:///.agents/rules/coding_guardrails.md).

### Ringkasan Poin Kritis:
1. **Modal & Notifikasi Seragam (No Native Alert/Confirm):**
   - Dilarang memakai `alert()`, `confirm()`, atau `prompt()`.
   - Gunakan selalu modal `showConfirm({ title, message, icon, okText, okDanger })` dan `showToast(msg, type)`.
2. **Room Scoping Pada Load/Poll Message:**
   - Semua pemanggilan API pesan (`/api/messages`, `/api/admin/messages`, Socket.IO `join_room`, form submit) **wajib menyertakan room filter aktif** agar tidak terjadi kebocoran pesan antar-room atau reset ke room general setelah interval polling.
   - Pagination di halaman admin harus selalu mempertahankan parameter `&room={{ room_filter }}`.
3. **Integritas Skrip & Event Handlers:**
   - Skrip utama seperti `static/script.js` dan `static/room-nav.js` bertanggung jawab atas fungsionalitas inti (pengiriman pesan, toolbar formatting, polling, reaksi emoji, pengaturan room).
   - Pastikan setiap fungsi yang dipanggil pada template HTML (`onclick="submitMessage()"`, `onclick="openRoomSettingsModal()"`, dll) terdefinisi secara global.
