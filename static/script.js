// ─── State ────────────────────────────────────────────────────────────────────

const feed       = document.getElementById('feedContainer');
const countEl    = document.getElementById('feedCount');

// Current page — polling only runs on page 1
const currentPage  = feed ? parseInt(feed.dataset.page || '1') : 1;
let latestId        = feed ? parseInt(feed.dataset.latestId || '0') : 0;
let pollInterval    = null;
const PER_PAGE      = 20;
// Parse initial total from text like "15 pesan" → 15
let lastKnownTotal  = parseInt((document.getElementById('feedCount')?.textContent || '0').replace(/\D/g, '')) || 0;
let unpinnedTotal   = feed ? parseInt(feed.dataset.unpinnedTotal || '0') : 0;

// ─── Announcement ─────────────────────────────────────────────────────────────

async function fetchAnnouncement() {
  const banner = document.getElementById('announcementBanner');
  const textEl = document.getElementById('announcementText');
  if (!banner || !textEl) return;

  try {
    const res = await fetch('/api/announcement');
    const data = await res.json();
    
    if (data.active && data.id) {
      const dismissed = localStorage.getItem('dismissed_announcement');
      if (dismissed !== String(data.id)) {
        textEl.textContent = data.content;
        banner.dataset.id = data.id;
        banner.classList.remove('hidden');
      }
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) {
    // silently fail
  }
}

function dismissAnnouncement() {
  const banner = document.getElementById('announcementBanner');
  if (banner) {
    banner.classList.add('hidden');
    const id = banner.dataset.id;
    if (id) {
      localStorage.setItem('dismissed_announcement', id);
    }
  }
}

if (currentPage === 1) fetchAnnouncement();

// ─── Character Counter ────────────────────────────────────────────────────────

const textarea = document.getElementById('messageInput');
const counter  = document.getElementById('charCounter');

if (textarea && counter) {
  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    counter.textContent = `${len} / 500`;
    counter.classList.toggle('near-limit', len >= 400 && len < 480);
    counter.classList.toggle('at-limit', len >= 480);
  });
}

const imageInput = document.getElementById('imageInput');
const imageLabel = document.getElementById('imageLabel');
if (imageInput && imageLabel) {
  imageInput.addEventListener('change', () => {
    if (imageInput.files && imageInput.files.length > 0) {
      imageLabel.textContent = '1 Gambar';
    } else {
      imageLabel.textContent = 'Gambar';
    }
  });
}

// ─── Submit Message ───────────────────────────────────────────────────────────

async function submitMessage() {
  const input    = document.getElementById('messageInput');
  const btn      = document.getElementById('submitBtn');
  const feedback = document.getElementById('submitFeedback');

  const message = input.value.trim();
  if (!message) return;

  if (imageInput && imageInput.files[0]) {
    const file = imageInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      showFeedback(feedback, 'error', 'Ukuran gambar maksimal 5MB.');
      btn.disabled = false;
      btn.querySelector('.btn-text').textContent = 'Kirim';
      return;
    }
  }

  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Mengirim…';
  feedback.className = 'submit-feedback hidden';

  try {
    const formData = new FormData();
    formData.append('message', message);
    if (imageInput && imageInput.files[0]) {
      formData.append('image', imageInput.files[0]);
    }

    const res  = await fetch('/api/submit', {
      method:  'POST',
      body:    formData
    });
    const data = await res.json();

    if (!res.ok) {
      showFeedback(feedback, 'error', data.error || 'Terjadi kesalahan.');
      return;
    }

    input.value = '';
    if (counter) {
      counter.textContent = '0 / 500';
      counter.classList.remove('near-limit', 'at-limit');
    }
    if (imageInput) {
      imageInput.value = '';
      if (imageLabel) imageLabel.textContent = 'Gambar';
    }

    showFeedback(feedback, 'success', '✓ Pesanmu telah terkirim!');

    if (data.message && data.message.secret_token) {
      saveMyMessage(data.message.id, data.message.secret_token, data.message.timestamp_ms);
    }

    // Inject own message immediately (skip pending buffer — own message shown right away)
    if (currentPage === 1 && data.message) {
      const msg = data.message;
      injectMessageCard(msg, true);
      // Update latestId so next poll ignores our own message
      if (msg.id > latestId) latestId = msg.id;
      // Update count
      updateCount(data.total, data.unpinned_total);
    }

  } catch (e) {
    showFeedback(feedback, 'error', 'Gagal mengirim. Coba lagi.');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Kirim';
  }
}

// ─── Realtime Polling ─────────────────────────────────────────────────────────

async function poll() {
  if (currentPage !== 1) return; // only poll on first page

  fetchAnnouncement();

  try {
    const res  = await fetch(`/api/messages?since=${latestId}`);
    const data = await res.json();

    // Update count regardless
    if (data.total !== undefined) {
      updateCount(data.total, data.unpinned_total);
    }

    // Update reply counts for all rendered messages in real-time
    if (data.reply_counts) {
      for (const [id, count] of Object.entries(data.reply_counts)) {
        const labelEl = document.querySelector(`#msg-${id} .reply-label`);
        if (labelEl) {
          labelEl.textContent = count > 0 ? `Balas · ${count}` : 'Balas';
        }
      }
    }

    // Update vote counts and pinned state
    if (data.vote_counts) {
      for (const [idStr, counts] of Object.entries(data.vote_counts)) {
        const upEl = document.getElementById(`upvote-count-${idStr}`);
        if (upEl) upEl.textContent = counts.u;
        const downEl = document.getElementById(`downvote-count-${idStr}`);
        if (downEl) downEl.textContent = counts.d;
        
        const card = document.getElementById(`msg-${idStr}`);
        if (card) {
          if (counts.p && !card.classList.contains('pinned-message')) {
            card.classList.add('pinned-message');
            const p = card.querySelector('.message-text');
            if (p && !card.querySelector('.pinned-badge')) {
              p.insertAdjacentHTML('beforebegin', `
                <div class="pinned-badge">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="12" height="12">
                    <path d="M16 3H8C7.4 3 7 3.4 7 4V13L5 16V18H11V22L12 23L13 22V18H19V16L17 13V4C17 3.4 16.6 3 16 3Z"/>
                  </svg>
                  Trending Topic
                </div>
              `);
            }
            moveCardToCorrectContainer(card, true);
          } else if (!counts.p && card.classList.contains('pinned-message')) {
            card.classList.remove('pinned-message');
            const badge = card.querySelector('.pinned-badge');
            if (badge) badge.remove();
            moveCardToCorrectContainer(card, false);
          }
        }
      }
    }

    // Remove top-level cards that are no longer visible
    if (data.visible_ids) {
      const visibleSet = new Set(data.visible_ids);
      let removedAny = false;
      const missingIds = [];

      document.querySelectorAll('.message-card').forEach(card => {
        const id = parseInt(card.dataset.id);
        if (id && !visibleSet.has(id)) {
          card.remove();
          removedAny = true;
        }
      });

      if (removedAny) {
        document.querySelectorAll('.date-separator').forEach(sep => {
          const next = sep.nextElementSibling;
          if (!next || next.classList.contains('date-separator') || next.classList.contains('pagination') || next.classList.contains('empty-state')) {
            sep.remove();
          }
        });
      }

      // Detect newly unhidden top-level messages
      let oldestId = latestId;
      document.querySelectorAll('.message-card:not(.pinned-message)').forEach(card => {
        const cid = parseInt(card.dataset.id);
        if (cid && cid < oldestId) oldestId = cid;
      });

      data.visible_ids.forEach(id => {
        if (id >= oldestId && id <= latestId && !document.getElementById(`msg-${id}`)) {
          missingIds.push(id);
        }
      });

      if (missingIds.length > 0) {
        window.location.reload();
        return;
      }
    }

    // Remove replies that are no longer visible
    if (data.visible_replies) {
      const replySet = new Set(data.visible_replies);
      document.querySelectorAll('.reply-card').forEach(card => {
        const id = parseInt(card.dataset.id);
        if (id && !replySet.has(id)) {
          card.remove();
        }
      });
    }

    if (!data.messages || data.messages.length === 0) return;

    // Filter out any we already know about
    const newMsgs = data.messages.filter(m => m.id > latestId);
    
    if (newMsgs.length > 0) {
      // Sort ascending so oldest-new goes in first → newest at top
      newMsgs.sort((a, b) => a.id - b.id);

      newMsgs.forEach(msg => {
        injectMessageCard(msg, true);
        if (msg.id > latestId) latestId = msg.id;
      });
    }

  } catch (e) {
    // Silently fail — network hiccup
  }
}

// ─── Card Injection Helper ────────────────────────────────────────────────────

function injectMessageCard(msg, highlight) {
  if (!feed) return;

  // Remove empty state if present
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Ensure date separator exists for this message's date
  const existingSep = feed.querySelector(`.date-separator[data-date-key="${msg.date_key}"]`);
  if (!existingSep) {
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.dataset.dateKey = msg.date_key;
    sep.innerHTML = `<span class="date-label">${msg.date_label}</span>`;
    feed.insertBefore(sep, feed.firstChild);
  }

  const replyCount   = msg.reply_count || 0;
  const replyLabel   = replyCount > 0 ? `Balas · ${replyCount}` : 'Balas';

  // Build card matching the Jinja2 template structure exactly
  const card = document.createElement('article');
  card.className = highlight ? 'message-card new-card' : 'message-card';
  if (msg.is_pinned) card.classList.add('pinned-message');
  card.id = `msg-${msg.id}`;
  card.dataset.id = msg.id;
  
  let pinnedBadge = '';
  if (msg.is_pinned) {
    pinnedBadge = `
      <div class="pinned-badge">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="12" height="12">
          <path d="M16 3H8C7.4 3 7 3.4 7 4V13L5 16V18H11V22L12 23L13 22V18H19V16L17 13V4C17 3.4 16.6 3 16 3Z"/>
        </svg>
        Trending Topic
      </div>
    `;
  }

  card.innerHTML = `
    ${pinnedBadge}
    <p class="message-text">${escapeHtml(msg.content)}</p>
    ${msg.image_filename ? `<div class="message-image-container" style="margin-top: 12px;"><img src="/static/uploads/${msg.image_filename}" alt="Uploaded Image" style="max-width: 100%; max-height: 400px; border-radius: var(--radius); border: 1px solid var(--border);"></div>` : ''}
    <div class="message-meta">
      <time class="message-time">${msg.time}</time>
      <div class="meta-actions">
        <span class="user-delete-container" id="user-del-${msg.id}"></span>
        <button class="vote-btn upvote-btn" onclick="voteMessage(${msg.id}, 'up')" id="upvote-${msg.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <path d="M12 19V5M5 12l7-7 7 7"/>
          </svg>
          <span id="upvote-count-${msg.id}">${msg.upvotes || 0}</span>
        </button>
        <button class="vote-btn downvote-btn" onclick="voteMessage(${msg.id}, 'down')" id="downvote-${msg.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <path d="M12 5v14M19 12l-7 7-7-7"/>
          </svg>
          <span id="downvote-count-${msg.id}">${msg.downvotes || 0}</span>
        </button>
        <button class="reply-toggle-btn" onclick="toggleReply(${msg.id}, this)" data-open="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="reply-label">${replyLabel}</span>
        </button>
        <button class="vote-btn" onclick="reportMessage(${msg.id})" title="Laporkan Pesan" style="color: var(--danger); margin-left: auto;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line>
          </svg>
        </button>
      </div>
    </div>
    <div class="reply-thread hidden" id="thread-${msg.id}">
      <div class="reply-list" id="reply-list-${msg.id}">
        <p class="reply-loading">Memuat balasan…</p>
      </div>
      <div class="reply-form">
        <textarea
          id="reply-input-${msg.id}"
          class="reply-textarea"
          placeholder="Tulis balasan anonim…"
          maxlength="500"
          rows="2"
        ></textarea>
        <div class="reply-form-footer">
          <span class="reply-char-counter" id="reply-counter-${msg.id}">0 / 500</span>
          <button class="btn-reply-send" onclick="submitReply(${msg.id})">Kirim Balasan</button>
        </div>
      </div>
    </div>
  `;

  // Insert right after the top date separator
  const topSep = feed.querySelector('.date-separator');
  if (topSep && topSep.nextSibling) {
    feed.insertBefore(card, topSep.nextSibling);
  } else {
    feed.insertBefore(card, feed.firstChild);
  }

  if (highlight) {
    setTimeout(() => card.classList.remove('new-card'), 600);
  }
  
  // Re-apply vote states for injected message
  if (localStorage.getItem(`voted_${msg.id}_up`)) {
    const btn = card.querySelector('.upvote-btn');
    if (btn) btn.classList.add('voted-active');
  }
  if (localStorage.getItem(`voted_${msg.id}_down`)) {
    const btn = card.querySelector('.downvote-btn');
    if (btn) btn.classList.add('voted-active');
  }
}


// ─── Count & Pagination Helpers ──────────────────────────────────────────────

function updateCount(total, unpinnedTotalParam) {
  if (countEl) countEl.textContent = `${total} pesan`;

  const currentUnpinned = unpinnedTotalParam !== undefined ? unpinnedTotalParam : unpinnedTotal;

  // Only update pagination if total unpinned pages changed
  const prevPages = Math.ceil(unpinnedTotal / PER_PAGE);
  const newPages  = Math.ceil(currentUnpinned / PER_PAGE);
  if (newPages !== prevPages || (newPages > 1 && !document.querySelector('.pagination'))) {
    updatePagination(currentUnpinned);
  }
  
  lastKnownTotal = total;
  unpinnedTotal = currentUnpinned;
}

/**
 * Dynamically render or update the pagination nav below the feed.
 * We're always on page 1 when this runs (polling is page-1-only).
 */
function updatePagination(total) {
  const feedSection = document.querySelector('.feed-section');
  if (!feedSection) return;

  const totalPages = Math.ceil(total / PER_PAGE);

  // No pagination needed
  if (totalPages <= 1) {
    const existing = document.querySelector('.pagination');
    if (existing) existing.remove();
    return;
  }

  // Build page numbers HTML (show up to 5 around current page = 1)
  let numsHtml = '';
  const maxShown = 5;
  const end = Math.min(totalPages, maxShown);

  for (let p = 1; p <= end; p++) {
    if (p === 1) {
      numsHtml += `<span class="page-num page-num--active">1</span>`;
    } else {
      numsHtml += `<a href="?page=${p}" class="page-num">${p}</a>`;
    }
  }
  if (totalPages > maxShown) {
    numsHtml += `<span class="page-ellipsis">…</span>`;
    numsHtml += `<a href="?page=${totalPages}" class="page-num">${totalPages}</a>`;
  }

  const html = `
    <span class="page-btn page-btn--disabled">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
      Sebelumnya
    </span>
    <div class="page-numbers">${numsHtml}</div>
    <a href="?page=2" class="page-btn">
      Berikutnya
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
    </a>
  `;

  let nav = document.querySelector('.pagination');
  if (nav) {
    nav.innerHTML = html;
  } else {
    nav = document.createElement('nav');
    nav.className = 'pagination';
    nav.setAttribute('aria-label', 'Navigasi halaman');
    nav.innerHTML = html;
    feedSection.appendChild(nav);
  }
}

// ─── Feedback Helper ──────────────────────────────────────────────────────────

function showFeedback(el, type, text) {
  el.textContent = text;
  el.className   = `submit-feedback ${type}`;
  setTimeout(() => { el.className = 'submit-feedback hidden'; }, 4000);
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Trigger reflow
  void toast.offsetWidth;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── XSS-safe HTML escape ─────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Ctrl+Enter Shortcut ─────────────────────────────────────────────────────

if (textarea) {
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitMessage();
    }
  });
}

// ─── Reply Functions ──────────────────────────────────────────────────────────

// Track which threads have already been loaded
const loadedThreads = new Set();

async function toggleReply(msgId, btn) {
  const thread = document.getElementById(`thread-${msgId}`);
  const isOpen = btn.dataset.open === 'true';

  if (isOpen) {
    // Close
    thread.classList.add('hidden');
    btn.dataset.open = 'false';
    btn.classList.remove('is-open');
    return;
  }

  // Open
  thread.classList.remove('hidden');
  btn.dataset.open = 'true';
  btn.classList.add('is-open');

  // Load replies only once (unless forced)
  if (!loadedThreads.has(msgId)) {
    await loadReplies(msgId);
    loadedThreads.add(msgId);

    // Setup char counter and Ctrl+Enter shortcut for this reply input
    const input   = document.getElementById(`reply-input-${msgId}`);
    const counter = document.getElementById(`reply-counter-${msgId}`);
    if (input && counter) {
      input.addEventListener('input', () => {
        counter.textContent = `${input.value.length} / 500`;
      });
      
      // Ctrl+Enter shortcut
      input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          submitReply(msgId);
        }
      });
    }
  }
}

async function loadReplies(msgId) {
  const listEl = document.getElementById(`reply-list-${msgId}`);
  if (!listEl) return;

  try {
    const res  = await fetch(`/api/replies/${msgId}`);
    const data = await res.json();

    if (!data.replies || data.replies.length === 0) {
      listEl.innerHTML = `<p class="reply-empty">Belum ada balasan. Jadilah yang pertama!</p>`;
      return;
    }

    listEl.innerHTML = data.replies.map(r => buildReplyCard(r)).join('');
  } catch {
    listEl.innerHTML = `<p class="reply-empty">Gagal memuat balasan.</p>`;
  }
}

function buildReplyCard(reply, isNew = false) {
  return `
    <div class="reply-card${isNew ? ' new-reply' : ''}" id="reply-${reply.id}" data-id="${reply.id}">
      <div class="reply-avatar">anon</div>
      <div class="reply-bubble">
        <p class="reply-text">${escapeHtml(reply.content)}</p>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <time class="reply-time" style="margin-top: 0;">${reply.time}</time>
          <span class="user-delete-container" id="user-del-${reply.id}"></span>
        </div>
      </div>
    </div>`;
}

async function submitReply(msgId) {
  const input = document.getElementById(`reply-input-${msgId}`);
  const btn   = document.querySelector(`#thread-${msgId} .btn-reply-send`);
  const content = input.value.trim();

  if (!content) return;

  btn.disabled = true;
  btn.textContent = 'Mengirim…';

  try {
    const res  = await fetch('/api/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: content, parent_id: msgId })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Gagal mengirim balasan.', 'error');
      return;
    }

    // Clear input & counter
    input.value = '';
    const counter = document.getElementById(`reply-counter-${msgId}`);
    if (counter) counter.textContent = '0 / 500';

    if (data.message && data.message.secret_token) {
      saveMyMessage(data.message.id, data.message.secret_token, data.message.timestamp_ms);
    }

    // Remove "Belum ada balasan" placeholder if present
    const listEl = document.getElementById(`reply-list-${msgId}`);
    const empty  = listEl.querySelector('.reply-empty');
    if (empty) empty.remove();

    // Inject the new reply card
    listEl.insertAdjacentHTML('beforeend', buildReplyCard(data.message, true));

    // Update reply count on the toggle button
    updateReplyCount(msgId);

  } catch {
    showToast('Gagal mengirim. Coba lagi.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kirim Balasan';
  }
}

function updateReplyCount(msgId) {
  const listEl  = document.getElementById(`reply-list-${msgId}`);
  const cards   = listEl ? listEl.querySelectorAll('.reply-card').length : 0;
  const labelEl = document.querySelector(`#msg-${msgId} .reply-label`);
  if (labelEl) {
    labelEl.textContent = cards > 0 ? `Balas · ${cards}` : 'Balas';
  }
}

// ─── Update injectMessageCard to include reply button ─────────────────────────

// (Override the reply_count field for newly polled messages)
const _origInject = injectMessageCard;

// ─── 1-Minute Delete Feature ───────────────────────────────────────────────────

function getMyMessages() {
  try {
    return JSON.parse(localStorage.getItem('fgfess_my_msgs') || '{}');
  } catch {
    return {};
  }
}

function saveMyMessage(id, token, serverTimestampMs) {
  const msgs = getMyMessages();
  // We use the browser's Date.now() to avoid clock skew between server and client
  msgs[id] = { token, expires: Date.now() + 60000 };
  localStorage.setItem('fgfess_my_msgs', JSON.stringify(msgs));
  updateDeleteCountdowns(); // immediate update
}

async function userDeleteMsg(msgId) {
  const msgs = getMyMessages();
  if (!msgs[msgId]) return;

  const btn = document.querySelector(`#user-del-${msgId} button`);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/user_delete/${msgId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: msgs[msgId].token })
    });
    
    if (res.ok) {
      // Remove from localStorage
      delete msgs[msgId];
      localStorage.setItem('fgfess_my_msgs', JSON.stringify(msgs));
      
      // Remove from screen
      const card = document.getElementById(`msg-${msgId}`) || document.getElementById(`reply-${msgId}`);
      if (card) {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
      }
    } else {
      const data = await res.json();
      showToast(data.error || 'Gagal menghapus pesan.', 'error');
    }
  } catch (e) {
    showToast('Gagal menghapus pesan.', 'error');
  }
  if (btn) btn.disabled = false;
}

function updateDeleteCountdowns() {
  const msgs = getMyMessages();
  const now = Date.now();
  let changed = false;

  for (const id in msgs) {
    const item = msgs[id];
    const container = document.getElementById(`user-del-${id}`);

    if (now > item.expires) {
      delete msgs[id];
      changed = true;
      if (container) container.innerHTML = '';
    } else {
      if (container) {
        const secs = Math.ceil((item.expires - now) / 1000);
        if (!container.innerHTML) {
          container.innerHTML = `<button class="btn-user-delete" onclick="userDeleteMsg(${id})" title="Hapus pesan (tersedia 1 menit)">Hapus (${secs}s)</button>`;
        } else {
          const btn = container.querySelector('button');
          if (btn) btn.textContent = `Hapus (${secs}s)`;
        }
      }
    }
  }

  if (changed) {
    localStorage.setItem('fgfess_my_msgs', JSON.stringify(msgs));
  }
}

// Run countdown every second
setInterval(updateDeleteCountdowns, 1000);
// Initial run on load
updateDeleteCountdowns();

// ─── Voting Functionality ──────────────────────────────────────────────────────

function moveCardToCorrectContainer(card, isPinned) {
  const pinnedContainer = document.getElementById('pinnedContainer');
  const pinnedList = document.getElementById('pinnedMessagesList');
  const feedContainer = document.getElementById('feedContainer');
  
  if (isPinned) {
    if (pinnedContainer && pinnedList && !pinnedList.contains(card)) {
      pinnedList.appendChild(card);
      pinnedContainer.classList.remove('hidden');
    }
  } else {
    // move back to feedContainer
    if (feedContainer && !feedContainer.contains(card)) {
      const topSep = feedContainer.querySelector('.date-separator');
      if (topSep && topSep.nextSibling) {
        feedContainer.insertBefore(card, topSep.nextSibling);
      } else {
        feedContainer.insertBefore(card, feedContainer.firstChild);
      }
    }
    // Hide pinned container if empty
    if (pinnedContainer && pinnedList && pinnedList.children.length === 0) {
      pinnedContainer.classList.add('hidden');
    }
  }
}

function initializeVotes() {
  document.querySelectorAll('.message-card').forEach(card => {
    const id = card.dataset.id;
    if (localStorage.getItem(`voted_${id}_up`)) {
      const btn = card.querySelector('.upvote-btn');
      if (btn) btn.classList.add('voted-active');
    }
    if (localStorage.getItem(`voted_${id}_down`)) {
      const btn = card.querySelector('.downvote-btn');
      if (btn) btn.classList.add('voted-active');
    }
  });
}

// Call once on load
initializeVotes();

async function voteMessage(msgId, voteType) {
  try {
    const isVoted = localStorage.getItem(`voted_${msgId}_${voteType}`);
    const oppositeType = voteType === 'up' ? 'down' : 'up';
    const isOppositeVoted = localStorage.getItem(`voted_${msgId}_${oppositeType}`);

    // Jika ingin nge-vote, tapi sebelahnya sudah di-vote, kita undo sebelahnya dulu
    if (isOppositeVoted && !isVoted) {
      await fetch(`/api/messages/${msgId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: oppositeType, action: 'undo' })
      });
      localStorage.removeItem(`voted_${msgId}_${oppositeType}`);
      const oppBtn = document.getElementById(`${oppositeType}vote-${msgId}`);
      if (oppBtn) oppBtn.classList.remove('voted-active');
    }

    // Basic local check
    const action = isVoted ? 'undo' : 'vote';

    const res = await fetch(`/api/messages/${msgId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: voteType, action: action })
    });
    const data = await res.json();
    
    if (res.ok) {
      const btn = document.getElementById(`${voteType}vote-${msgId}`);
      if (action === 'vote') {
        localStorage.setItem(`voted_${msgId}_${voteType}`, 'true');
        if (btn) btn.classList.add('voted-active');
      } else {
        localStorage.removeItem(`voted_${msgId}_${voteType}`);
        if (btn) btn.classList.remove('voted-active');
      }
      
      const upEl = document.getElementById(`upvote-count-${msgId}`);
      if (upEl) upEl.textContent = data.upvotes;
      
      const downEl = document.getElementById(`downvote-count-${msgId}`);
      if (downEl) downEl.textContent = data.downvotes;
      
      if (data.is_hidden) {
        // Remove card
        const card = document.getElementById(`msg-${msgId}`);
        if (card) {
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 300);
        }
      } else if (data.is_pinned) {
        // Add pinned class and badge if not exists
        const card = document.getElementById(`msg-${msgId}`);
        if (card && !card.classList.contains('pinned-message')) {
          card.classList.add('pinned-message');
          const p = card.querySelector('.message-text');
          if (p) {
            p.insertAdjacentHTML('beforebegin', `
              <div class="pinned-badge">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="12" height="12">
                  <path d="M16 3H8C7.4 3 7 3.4 7 4V13L5 16V18H11V22L12 23L13 22V18H19V16L17 13V4C17 3.4 16.6 3 16 3Z"/>
                </svg>
                Trending Topic
              </div>
            `);
          }
          moveCardToCorrectContainer(card, true);
        }
      } else {
        // Unpin if necessary (undone)
        const card = document.getElementById(`msg-${msgId}`);
        if (card && card.classList.contains('pinned-message')) {
          card.classList.remove('pinned-message');
          const badge = card.querySelector('.pinned-badge');
          if (badge) badge.remove();
          moveCardToCorrectContainer(card, false);
        }
      }
    } else {
      showToast(data.error || 'Gagal mengirim vote.', 'error');
    }
  } catch (e) {
    showToast('Terjadi kesalahan. Coba lagi.', 'error');
  }
}

// ─── Start Polling (page 1 only) ─────────────────────────────────────────────

if (currentPage === 1) {
  pollInterval = setInterval(poll, 5000); // every 5 seconds
}

function showConfirm(msg, title = "Konfirmasi", icon = "⚠️", okText = "Ya") {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-icon">${icon}</div>
        <div class="confirm-title">${title}</div>
        <div class="confirm-msg">${msg}</div>
        <div class="confirm-actions">
          <button class="confirm-cancel" id="confirmCancel">Batal</button>
          <button class="confirm-ok" id="confirmOk">${okText}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirmOk').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirmCancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

function showReportModal() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box" style="text-align: left;">
        <div class="confirm-icon" style="text-align: center;">🚩</div>
        <div class="confirm-title" style="text-align: center;">Laporkan Pesan</div>
        <div class="confirm-msg" style="margin-bottom: 12px; text-align: center;">Pilih alasan pelaporan:</div>
        <select id="reportReason" style="width: 100%; padding: 8px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text);">
          <option value="Spam atau Promosi">Spam atau Promosi</option>
          <option value="Konten Tidak Pantas / NSFW">Konten Tidak Pantas / NSFW</option>
          <option value="Kekerasan atau Bullying">Kekerasan atau Bullying</option>
          <option value="Ujaran Kebencian">Ujaran Kebencian</option>
          <option value="Lainnya">Lainnya</option>
        </select>
        <input type="text" id="customReason" placeholder="Tuliskan alasan..." style="display: none; width: 100%; padding: 8px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); font-size: 0.85rem; box-sizing: border-box;" maxlength="250">
        <div class="confirm-actions" style="margin-top: 16px;">
          <button class="confirm-cancel" id="reportCancel">Batal</button>
          <button class="confirm-ok" id="reportOk" style="background: var(--danger);">Laporkan</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    
    const selectEl = overlay.querySelector('#reportReason');
    const customEl = overlay.querySelector('#customReason');
    
    selectEl.addEventListener('change', () => {
      if (selectEl.value === 'Lainnya') {
        customEl.style.display = 'block';
        customEl.focus();
      } else {
        customEl.style.display = 'none';
      }
    });

    overlay.querySelector('#reportOk').onclick = () => { 
      let reason = selectEl.value;
      if (reason === 'Lainnya') {
        reason = customEl.value.trim() || 'Lainnya';
      }
      overlay.remove(); 
      resolve(reason); 
    };
    overlay.querySelector('#reportCancel').onclick = () => { overlay.remove(); resolve(null); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
  });
}

async function reportMessage(msgId) {
  if (localStorage.getItem(`reported_${msgId}`)) {
    showToast('Pesan ini sudah pernah kamu laporkan.', 'info');
    return;
  }
  
  const reason = await showReportModal();
  if (!reason) return;
  
  try {
    const res = await fetch(`/api/messages/${msgId}/report`, { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (res.ok) {
      localStorage.setItem(`reported_${msgId}`, 'true');
      showToast('Terima kasih. Pesan telah dilaporkan.', 'success');
    } else {
      showToast('Gagal melaporkan pesan.', 'error');
    }
  } catch (e) {
    showToast('Gagal melaporkan pesan.', 'error');
  }
}
