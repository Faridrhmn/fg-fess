// Dark mode functions are in /static/theme.js

// ─── State ───────────────────────────────────────────────────────────────────

// ─── State ───────────────────────────────────────────────────────────────────────

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
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const imagePreview = document.getElementById('imagePreview');

if (imageInput && imageLabel) {
  imageInput.addEventListener('change', () => {
    if (imageInput.files && imageInput.files.length > 0) {
      const file = imageInput.files[0];
      imageLabel.textContent = '1 Gambar';
      if (imagePreviewContainer && imagePreview) {
        imagePreview.src = URL.createObjectURL(file);
        imagePreviewContainer.style.display = 'block';
      }
    } else {
      imageLabel.textContent = 'Gambar';
      if (imagePreviewContainer) {
        imagePreviewContainer.style.display = 'none';
      }
    }
  });
}

function removeImage() {
  if (imageInput) {
    imageInput.value = '';
    if (imageLabel) imageLabel.textContent = 'Gambar';
  }
  if (imagePreviewContainer) {
    imagePreviewContainer.style.display = 'none';
  }
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
      if (imagePreviewContainer) imagePreviewContainer.style.display = 'none';
    }

    showFeedback(feedback, 'success', '✓ Pesanmu telah terkirim!');

    if (data.message && data.message.secret_token) {
      saveMyMessage(data.message.id, data.message.secret_token, data.message.timestamp_ms);
    }

  } catch (e) {
    showFeedback(feedback, 'error', 'Gagal mengirim. Coba lagi.');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Kirim';
  }
}

// ─── Realtime WebSocket (Socket.IO) ───────────────────────────────────────────

const socket = io();

// State healing: fetch any missed messages if socket reconnects
socket.on('connect', async () => {
  if (currentPage !== 1 || !latestId) return;
  try {
    const res = await fetch(`/api/messages?since=${latestId}`);
    const data = await res.json();
    
    if (data.total !== undefined) {
      updateCount(data.total, data.unpinned_total);
    }
    
    if (data.messages && data.messages.length > 0) {
      const newMsgs = data.messages.filter(m => m.id > latestId);
      newMsgs.sort((a, b) => a.id - b.id);
      newMsgs.forEach(msg => {
        injectMessageCard(msg, true);
        if (msg.id > latestId) latestId = msg.id;
      });
    }
  } catch (e) {
    console.error('Failed to sync missed messages on reconnect:', e);
  }
});

socket.on('new_message', (data) => {
  if (currentPage !== 1) return; // Only update live on page 1
  
  if (data.total !== undefined) {
    updateCount(data.total, data.unpinned_total);
  }

  const msg = data.message;
  if (msg.id > latestId) {
    injectMessageCard(msg, true);
    latestId = msg.id;
  }
});

socket.on('new_reply', (msg) => {
  const replyList = document.getElementById(`reply-list-${msg.parent_id}`);
  if (replyList) {
    const thread = document.getElementById(`thread-${msg.parent_id}`);
    const isOpen = !thread.classList.contains('hidden');
    
    // If thread is open, add it directly
    if (isOpen) {
      // Remove loading or no-reply text if present
      const loading = replyList.querySelector('.reply-loading');
      if (loading) loading.remove();
      const noReply = replyList.querySelector('.no-replies');
      if (noReply) noReply.remove();
      
      const replyHtml = buildReplyCard(msg, true);
      replyList.insertAdjacentHTML('beforeend', replyHtml);
      setTimeout(() => {
        const newlyAdded = document.getElementById(`reply-${msg.id}`);
        if (newlyAdded) newlyAdded.classList.remove('new-card');
      }, 600);
    }
  }

  // Update reply count label
  const labelEl = document.querySelector(`#msg-${msg.parent_id} .reply-label`);
  if (labelEl) {
    // We just increment it locally since we know one was added
    let current = parseInt(labelEl.textContent.replace('Balas · ', '')) || 0;
    if (labelEl.textContent === 'Balas') current = 0;
    labelEl.textContent = `Balas · ${current + 1}`;
  }
});

socket.on('update_vote', (data) => {
  const { id, counts } = data;
  const upEl = document.getElementById(`upvote-count-${id}`);
  if (upEl) upEl.textContent = counts.upvotes;
  const downEl = document.getElementById(`downvote-count-${id}`);
  if (downEl) downEl.textContent = counts.downvotes;
  
  const card = document.getElementById(`msg-${id}`);
  if (card) {
    if (counts.is_pinned && !card.classList.contains('pinned-message')) {
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
    } else if (!counts.is_pinned && card.classList.contains('pinned-message')) {
      card.classList.remove('pinned-message');
      const badge = card.querySelector('.pinned-badge');
      if (badge) badge.remove();
      moveCardToCorrectContainer(card, false);
    }
  }
});

socket.on('update_reaction', (data) => {
  const bar = document.getElementById(`reactions-${data.id}`);
  if (bar) {
    renderReactionBar(bar, data.id, data.reactions);
  }
});

socket.on('message_deleted', (data) => {
  if (data.total !== undefined) {
    updateCount(data.total, data.unpinned_total);
  }

  const card = document.getElementById(`msg-${data.id}`);
  if (card) card.remove();
  
  const replyCard = document.getElementById(`reply-${data.id}`);
  if (replyCard) {
    const thread = replyCard.closest('.reply-thread');
    replyCard.remove();
    if (thread) {
      const msgId = thread.id.replace('thread-', '');
      updateReplyCount(msgId);
    }
  }
});

socket.on('message_unhidden', (data) => {
  // If an old message is unhidden, the simplest way to maintain 
  // chronological order is to reload the page. 
  // This is a rare admin action, so a refresh is acceptable.
  window.location.reload();
});


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
    <p class="message-text" data-raw="${escapeHtml(msg.content)}">${renderMessageContent(msg.content)}</p>
    ${msg.image_filename ? `<div class="message-image-container" style="margin-top: 12px;"><img src="/static/uploads/${msg.image_filename}" alt="Uploaded Image" style="max-width: 100%; max-height: 400px; border-radius: var(--radius); border: 1px solid var(--border);"></div>` : ''}
    <div class="message-meta">
      <time class="message-time">${msg.time}</time>
      <div class="meta-actions">
        <span class="user-delete-container" id="user-del-${msg.id}"></span>
        <button class="vote-btn reaction-trigger-btn" onclick="toggleReactionPicker(${msg.id}, this)" title="Tambah reaksi" id="react-btn-${msg.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 13s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
        </button>
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
    <div class="reactions-bar" id="reactions-${msg.id}"></div>
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
  
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    const bar = card.querySelector('.reactions-bar');
    if (bar) renderReactionBar(bar, msg.id, msg.reactions);
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

/**
 * Render text with #hashtag links. Escapes HTML first, then makes chips clickable.
 */
function renderMessageContent(rawText) {
  const escaped = escapeHtml(rawText);
  return escaped.replace(/(^|[\s\n])(#(\w+))/g, (match, pre, full, tag) => {
    return `${pre}<span class="hashtag-chip" onclick="filterByHashtag('${tag.toLowerCase()}')">${full}</span>`;
  });
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

// ─── Periodic Announcement Check ─────────────────────────────────────────────

if (currentPage === 1) {
  setInterval(fetchAnnouncement, 60000); // Check announcement every minute
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

// ─── Emoji Reaction System ────────────────────────────────────────────────────

const EMOJI_LIST = ['❤️', '😂', '😮', '😢', '😡', '👍'];

// Track user's own reactions in localStorage: { "msgId_emoji": true }
function getMyReactions() {
  try { return JSON.parse(localStorage.getItem('fgfess_reactions') || '{}'); }
  catch { return {}; }
}
function setMyReaction(msgId, emoji, active) {
  const key = `${msgId}_${emoji}`;
  const my = getMyReactions();
  if (active) my[key] = true; else delete my[key];
  localStorage.setItem('fgfess_reactions', JSON.stringify(my));
}
function hasMyReaction(msgId, emoji) {
  return !!getMyReactions()[`${msgId}_${emoji}`];
}

let openPickerId = null;  // currently open picker's msgId

function toggleReactionPicker(msgId, triggerBtn) {
  // Close existing picker if open
  closeAllPickers();

  if (openPickerId === msgId) {
    openPickerId = null;
    triggerBtn.classList.remove('picker-open');
    return;
  }

  openPickerId = msgId;
  triggerBtn.classList.add('picker-open');

  // Build picker
  const picker = document.createElement('div');
  picker.className = 'emoji-picker-popup';
  picker.id = `picker-${msgId}`;

  EMOJI_LIST.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-picker-btn';
    if (hasMyReaction(msgId, emoji)) btn.classList.add('already-reacted');
    btn.textContent = emoji;
    btn.title = emoji;
    btn.onclick = (e) => {
      e.stopPropagation();
      sendReaction(msgId, emoji);
      closeAllPickers();
    };
    picker.appendChild(btn);
  });

  // Position relative to trigger button
  const card = document.getElementById(`msg-${msgId}`);
  const meta = card ? card.querySelector('.message-meta') : null;
  if (meta) {
    meta.style.position = 'relative';
    meta.appendChild(picker);

    // Ensure picker doesn't overflow right edge
    const pickerRect = picker.getBoundingClientRect();
    if (pickerRect.right > window.innerWidth - 8) {
      picker.style.right = '0';
      picker.style.left = 'auto';
    }
    // Position above the meta bar
    picker.style.bottom = '130%';
    picker.style.left = picker.style.left || '0';
  }

  // Close when clicking outside
  setTimeout(() => {
    document.addEventListener('click', onOutsidePickerClick, { once: true });
  }, 10);
}

function onOutsidePickerClick(e) {
  if (!e.target.closest('.emoji-picker-popup') && !e.target.closest('.reaction-trigger-btn')) {
    closeAllPickers();
  }
}

function closeAllPickers() {
  document.querySelectorAll('.emoji-picker-popup').forEach(p => p.remove());
  document.querySelectorAll('.reaction-trigger-btn.picker-open').forEach(b => b.classList.remove('picker-open'));
  openPickerId = null;
  document.removeEventListener('click', onOutsidePickerClick);
}

async function sendReaction(msgId, emoji) {
  const wasReacted = hasMyReaction(msgId, emoji);

  // Optimistic update
  setMyReaction(msgId, emoji, !wasReacted);
  const bar = document.getElementById(`reactions-${msgId}`);
  if (bar) {
    // Temporarily update chip count optimistically
    const existingChip = bar.querySelector(`[data-emoji="${CSS.escape(emoji)}"]`);
    if (existingChip) {
      const countEl = existingChip.querySelector('.chip-count');
      const current = parseInt(countEl?.textContent || '0');
      if (wasReacted) {
        const newCount = current - 1;
        if (newCount <= 0) existingChip.remove();
        else if (countEl) countEl.textContent = newCount;
      } else {
        if (countEl) countEl.textContent = current + 1;
        existingChip.classList.add('my-reaction');
        triggerBurst(existingChip);
      }
    } else if (!wasReacted) {
      // New chip
      renderReactionBar(bar, msgId, { [emoji]: 1 });
    }
  }

  try {
    const res = await fetch(`/api/messages/${msgId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji })
    });
    const data = await res.json();
    if (data.success) {
      // Sync with server truth
      renderReactionBar(bar, msgId, data.reactions);
    } else {
      // Revert optimistic
      setMyReaction(msgId, emoji, wasReacted);
      showToast('Gagal menambahkan reaksi.', 'error');
    }
  } catch {
    setMyReaction(msgId, emoji, wasReacted);
    showToast('Gagal menambahkan reaksi.', 'error');
  }
}

/**
 * Render/update the reactions bar for a message.
 * @param {HTMLElement|null} bar  - the .reactions-bar element
 * @param {number}  msgId         - message id
 * @param {Object}  reactions     - {emoji: count} from server
 */
function renderReactionBar(bar, msgId, reactions) {
  if (!bar) bar = document.getElementById(`reactions-${msgId}`);
  if (!bar) return;

  // Filter out zero counts
  const entries = Object.entries(reactions).filter(([, c]) => c > 0);

  if (entries.length === 0) {
    bar.innerHTML = '';
    return;
  }

  // Sort by EMOJI_LIST order for consistent display
  entries.sort(([a], [b]) => EMOJI_LIST.indexOf(a) - EMOJI_LIST.indexOf(b));

  // Build new chips, preserve burst animation for changed chips
  const newHtml = entries.map(([emoji, count]) => {
    const mine = hasMyReaction(msgId, emoji);
    return `<button class="reaction-chip${mine ? ' my-reaction' : ''}"
              data-emoji="${emoji}" data-msg="${msgId}"
              onclick="sendReaction(${msgId}, '${emoji}')"
              title="${emoji}">
              <span class="chip-emoji">${emoji}</span>
              <span class="chip-count">${count}</span>
            </button>`;
  }).join('');

  bar.innerHTML = newHtml;
}

function triggerBurst(el) {
  el.classList.remove('burst');
  void el.offsetWidth; // reflow
  el.classList.add('burst');
  el.addEventListener('animationend', () => el.classList.remove('burst'), { once: true });
}

// ─── Hashtag System ───────────────────────────────────────────────────────────


let activeHashtag = null;

async function initHashtagSidebar() {
  const listEl     = document.getElementById('hashtagList');
  const mobileStrip = document.getElementById('hashtagMobileStrip');

  try {
    const res  = await fetch('/api/trending_hashtags');
    const data = await res.json();

    if (!data.hashtags || data.hashtags.length === 0) {
      if (listEl)      listEl.innerHTML = '<p class="hashtag-sidebar-empty">Belum ada hashtag</p>';
      if (mobileStrip) mobileStrip.style.display = 'none';
      return;
    }

    // ── Desktop sidebar ──
    if (listEl) {
      listEl.innerHTML = `<div class="hashtag-list">${
        data.hashtags.map(h => `
          <div class="hashtag-item" id="ht-${h.tag}" onclick="filterByHashtag('${h.tag}')">
            <span class="hashtag-item-tag">#${h.tag}</span>
            <span class="hashtag-item-count">${h.count}</span>
          </div>
        `).join('')
      }</div>`;
    }

    // ── Mobile chip strip ──
    if (mobileStrip) {
      mobileStrip.innerHTML = data.hashtags.map(h => `
        <div class="hashtag-mobile-chip" id="mcht-${h.tag}" onclick="filterByHashtag('${h.tag}')">
          #${h.tag}
          <span class="chip-count">${h.count}</span>
        </div>
      `).join('');
      // CSS media query handles show/hide — no JS width check needed
    }

  } catch (e) {
    if (listEl)      listEl.innerHTML = '<p class="hashtag-sidebar-empty">Gagal memuat</p>';
  }
}

// Update strip visibility on resize (CSS handles it, but this syncs JS if needed)
window.addEventListener('resize', () => {
  // No-op: CSS media queries handle all visibility
});



function filterByHashtag(tag) {
  const lowerTag = tag.toLowerCase();

  // Toggle off if same tag
  if (activeHashtag === lowerTag) {
    clearHashtagFilter();
    return;
  }

  activeHashtag = lowerTag;

  // Update sidebar active state (desktop)
  document.querySelectorAll('.hashtag-item').forEach(el => {
    el.classList.toggle('active-hashtag', el.id === `ht-${lowerTag}`);
  });

  // Update mobile chip active state
  document.querySelectorAll('.hashtag-mobile-chip').forEach(el => {
    el.classList.toggle('active-hashtag', el.id === `mcht-${lowerTag}`);
  });

  // Show/hide clear button (desktop sidebar)
  const clearBtn = document.getElementById('hashtagClearBtn');
  if (clearBtn) clearBtn.style.display = 'block';

  // Show filter banner
  const banner = document.getElementById('hashtagFilterBanner');
  if (banner) {
    banner.style.display = 'flex';
    banner.className = 'hashtag-filter-banner';
    banner.innerHTML = `
      <div>Menampilkan: <span>#${lowerTag}</span></div>
      <button class="hashtag-filter-close" onclick="clearHashtagFilter()" title="Hapus filter">✕</button>
    `;
  }

  // Filter visible message cards
  applyHashtagFilter(lowerTag);
}

function applyHashtagFilter(tag) {
  const pattern = new RegExp(`#${tag}\\b`, 'i');
  let visibleCount = 0;

  document.querySelectorAll('.message-card').forEach(card => {
    const rawText = card.querySelector('.message-text')?.dataset.raw || 
                    card.querySelector('.message-text')?.textContent || '';
    const matches = pattern.test(rawText);
    card.style.display = matches ? '' : 'none';
    if (matches) visibleCount++;
  });

  // Hide date separators that have no visible messages after them
  document.querySelectorAll('.date-separator').forEach(sep => {
    let next = sep.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('date-separator')) {
      if (next.classList.contains('message-card') && next.style.display !== 'none') {
        hasVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    sep.style.display = hasVisible ? '' : 'none';
  });
}

function clearHashtagFilter() {
  activeHashtag = null;

  // Remove active state from sidebar (desktop) and mobile chips
  document.querySelectorAll('.hashtag-item, .hashtag-mobile-chip').forEach(el => {
    el.classList.remove('active-hashtag');
  });

  // Hide clear button (desktop)
  const clearBtn = document.getElementById('hashtagClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  // Hide filter banner
  const banner = document.getElementById('hashtagFilterBanner');
  if (banner) banner.style.display = 'none';

  // Show all cards and date separators
  document.querySelectorAll('.message-card').forEach(card => card.style.display = '');
  document.querySelectorAll('.date-separator').forEach(sep => sep.style.display = '');
}

/**
 * Render hashtag chips on existing server-rendered message texts.
 * Called once on page load to make Jinja-rendered content also have clickable hashtags.
 */
function renderExistingHashtags() {
  document.querySelectorAll('.message-text').forEach(el => {
    const rawText = el.dataset.raw;
    if (!rawText) return; // already processed or no data-raw
    el.innerHTML = renderMessageContent(rawText);
  });
}

// Initialize on load
renderExistingHashtags();
if (currentPage === 1) {
  initHashtagSidebar();
  // Refresh hashtag sidebar every 2 minutes
  setInterval(initHashtagSidebar, 120000);
} else {
  // On other pages, still render hashtag chips but no sidebar fetch
  const sidebar = document.getElementById('hashtagSidebar');
  if (sidebar) sidebar.style.display = 'none';
}

// Render initial reactions on page load
if (window.INITIAL_REACTIONS) {
  Object.entries(window.INITIAL_REACTIONS).forEach(([msgId, reactions]) => {
    const bar = document.getElementById(`reactions-${msgId}`);
    if (bar) renderReactionBar(bar, parseInt(msgId), reactions);
  });
}
