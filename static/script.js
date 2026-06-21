// ─── State ────────────────────────────────────────────────────────────────────

const feed       = document.getElementById('feedContainer');
const countEl    = document.getElementById('feedCount');
const liveBar    = document.getElementById('liveIndicator');
const newCountEl = document.getElementById('newMsgCount');

// Current page — polling only runs on page 1
const currentPage  = feed ? parseInt(feed.dataset.page || '1') : 1;
let latestId        = feed ? parseInt(feed.dataset.latestId || '0') : 0;
let pendingMsgs     = []; // buffer for new messages while user hasn't clicked "Tampilkan"
let pollInterval    = null;
const PER_PAGE      = 20;
// Parse initial total from text like "15 pesan" → 15
let lastKnownTotal  = parseInt((document.getElementById('feedCount')?.textContent || '0').replace(/\D/g, '')) || 0;

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

// ─── Submit Message ───────────────────────────────────────────────────────────

async function submitMessage() {
  const input    = document.getElementById('messageInput');
  const btn      = document.getElementById('submitBtn');
  const feedback = document.getElementById('submitFeedback');

  const message = input.value.trim();
  if (!message) return;

  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Mengirim…';
  feedback.className = 'submit-feedback hidden';

  try {
    const res  = await fetch('/api/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message })
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
      updateCount(data.total);
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

  try {
    const res  = await fetch(`/api/messages?since=${latestId}`);
    const data = await res.json();

    // Update count regardless
    if (data.total !== undefined) updateCount(data.total);

    // Remove cards that are no longer visible (deleted or hidden by admin)
    if (data.visible_ids) {
      const visibleSet = new Set(data.visible_ids);
      let removedAny = false;

      document.querySelectorAll('.message-card, .reply-card').forEach(card => {
        const id = parseInt(card.dataset.id);
        if (id && !visibleSet.has(id)) {
          card.remove();
          removedAny = true;
        }
      });

      // Cleanup empty date separators if any top-level cards were removed
      if (removedAny) {
        document.querySelectorAll('.date-separator').forEach(sep => {
          const next = sep.nextElementSibling;
          if (!next || next.classList.contains('date-separator') || next.classList.contains('pagination') || next.classList.contains('empty-state')) {
            sep.remove();
          }
        });
      }
    }

    if (!data.messages || data.messages.length === 0) return;

    // Filter out any we already know about (either already shown or already in buffer)
    const newMsgs = data.messages.filter(m => 
      m.id > latestId && !pendingMsgs.some(p => p.id === m.id)
    );
    if (newMsgs.length === 0) return;

    // Add to pending buffer (newest last so we insert in order)
    pendingMsgs.push(...newMsgs);

    // Show the live notification bar
    if (liveBar && newCountEl) {
      newCountEl.textContent = pendingMsgs.length;
      liveBar.classList.remove('hidden');
    }

  } catch (e) {
    // Silently fail — network hiccup
  }
}

// Called when user clicks "Tampilkan" on the live bar
function loadNewMessages() {
  if (!pendingMsgs.length) return;

  // Sort ascending so oldest-new goes in first → newest at top
  pendingMsgs.sort((a, b) => a.id - b.id);

  pendingMsgs.forEach(msg => {
    injectMessageCard(msg, false);
    if (msg.id > latestId) latestId = msg.id;
  });

  pendingMsgs = [];

  // Hide live bar
  if (liveBar) liveBar.classList.add('hidden');
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
  card.id = `msg-${msg.id}`;
  card.dataset.id = msg.id;
  card.innerHTML = `
    <p class="message-text">${escapeHtml(msg.content)}</p>
    <div class="message-meta">
      <time class="message-time">${msg.time}</time>
      <div class="meta-actions">
        <span class="user-delete-container" id="user-del-${msg.id}"></span>
        <button class="reply-toggle-btn" onclick="toggleReply(${msg.id}, this)" data-open="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="reply-label">${replyLabel}</span>
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
}


// ─── Count & Pagination Helpers ──────────────────────────────────────────────

function updateCount(total) {
  if (countEl) countEl.textContent = `${total} pesan`;

  // Only update pagination if total pages changed
  const prevPages = Math.ceil(lastKnownTotal / PER_PAGE);
  const newPages  = Math.ceil(total / PER_PAGE);
  if (newPages !== prevPages || (newPages > 1 && !document.querySelector('.pagination'))) {
    updatePagination(total);
  }
  lastKnownTotal = total;
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
        <time class="reply-time">${reply.time}</time>
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
      alert(data.error || 'Gagal mengirim balasan.');
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
    alert('Gagal mengirim. Coba lagi.');
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

function saveMyMessage(id, token, timestampMs) {
  const msgs = getMyMessages();
  msgs[id] = { token, expires: timestampMs + 60000 };
  localStorage.setItem('fgfess_my_msgs', JSON.stringify(msgs));
  updateDeleteCountdowns(); // immediate update
}

async function userDeleteMsg(msgId) {
  const msgs = getMyMessages();
  if (!msgs[msgId]) return;

  if (!confirm('Hapus pesan ini?')) return;

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
      alert(data.error || 'Gagal menghapus pesan.');
    }
  } catch (e) {
    alert('Gagal menghapus pesan.');
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

// ─── Start Polling (page 1 only) ─────────────────────────────────────────────

if (currentPage === 1) {
  pollInterval = setInterval(poll, 5000); // every 5 seconds
}
