from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from apscheduler.schedulers.background import BackgroundScheduler
import datetime
import os
import urllib.request
import json
import uuid
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(24))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///messages.db?timeout=20'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# SQLite optimasi: WAL mode agar read & write bisa jalan bersamaan
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'connect_args': {'check_same_thread': False},
    'pool_size': 10,
    'pool_timeout': 20,
    'pool_recycle': 300,
}

# ─── Indonesian Date Formatter ─────────────────────────────────────────────────
_HARI  = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu']
_BULAN = ['','Januari','Februari','Maret','April','Mei','Juni',
          'Juli','Agustus','September','Oktober','November','Desember']

def fmt_date_id(dt):
    """Return Indonesian full date string: 'Minggu, 21 Juni 2026'"""
    return f"{_HARI[dt.weekday()]}, {dt.day:02d} {_BULAN[dt.month]} {dt.year}"

def fmt_date_key(dt):
    """Return YYYY-MM-DD key for grouping."""
    return dt.strftime('%Y-%m-%d')

@app.template_filter('tgl_id')
def tgl_id_filter(dt):
    return fmt_date_id(dt)

@app.template_filter('tgl_key')
def tgl_key_filter(dt):
    return fmt_date_key(dt)

@app.after_request
def add_header(response):
    # Hanya non-cache untuk halaman HTML dinamis, bukan static assets
    if response.content_type and 'text/html' in response.content_type:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '-1'
    return response

# ─── Simple In-Memory Rate Limiter ────────────────────────────────────────────────
_rate_limit_store = {}  # {ip: [timestamp, ...]}
_RATE_LIMIT = 5         # maks 5 pesan
_RATE_WINDOW = 60       # per 60 detik

def is_rate_limited(ip):
    now = datetime.datetime.utcnow().timestamp()
    window_start = now - _RATE_WINDOW
    timestamps = _rate_limit_store.get(ip, [])
    # Buang timestamps di luar window
    timestamps = [t for t in timestamps if t > window_start]
    if len(timestamps) >= _RATE_LIMIT:
        _rate_limit_store[ip] = timestamps
        return True
    timestamps.append(now)
    _rate_limit_store[ip] = timestamps
    return False

_feedback_rate_limit_store = {}
_FEEDBACK_RATE_LIMIT = 3
_FEEDBACK_RATE_WINDOW = 86400  # 24 jam dalam detik

def is_feedback_rate_limited(ip):
    now = datetime.datetime.utcnow().timestamp()
    window_start = now - _FEEDBACK_RATE_WINDOW
    timestamps = _feedback_rate_limit_store.get(ip, [])
    # Buang timestamps di luar window
    timestamps = [t for t in timestamps if t > window_start]
    if len(timestamps) >= _FEEDBACK_RATE_LIMIT:
        _feedback_rate_limit_store[ip] = timestamps
        return True
    timestamps.append(now)
    _feedback_rate_limit_store[ip] = timestamps
    return False

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# ─── Models ───────────────────────────────────────────────────────────────────

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(150), nullable=False)

def get_wib_time():
    """Returns the current time in WIB (UTC+7)."""
    return datetime.datetime.utcnow() + datetime.timedelta(hours=7)

class Message(db.Model):
    id        = db.Column(db.Integer, primary_key=True)
    content   = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=get_wib_time)
    is_hidden = db.Column(db.Boolean, default=False)
    parent_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=True)
    secret_token = db.Column(db.String(36), nullable=True)  # For 1-minute delete feature
    location = db.Column(db.String(100), default="Tidak diketahui")
    upvotes = db.Column(db.Integer, default=0)
    downvotes = db.Column(db.Integer, default=0)
    is_pinned = db.Column(db.Boolean, default=False)
    pinned_until = db.Column(db.DateTime, nullable=True)

    # Relationships
    replies   = db.relationship('Message',
                                backref=db.backref('parent', remote_side='Message.id'),
                                lazy='dynamic',
                                foreign_keys='Message.parent_id')

    @property
    def visible_reply_count(self):
        return self.replies.filter_by(is_hidden=False).count()


class Feedback(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=get_wib_time)
    location = db.Column(db.String(100), default="Tidak diketahui")
    admin_reply = db.Column(db.Text, nullable=True)
    admin_reply_timestamp = db.Column(db.DateTime, nullable=True)
    is_hidden = db.Column(db.Boolean, default=False)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ─── Public Routes ─────────────────────────────────────────────────────────────

@app.route('/')
def index():
    """Public menfess board - shows all visible top-level messages."""
    page = request.args.get('page', 1, type=int)
    per_page = 20
    
    # Unpin messages if their pinned_until has expired
    expired_pins = Message.query.filter(Message.is_pinned == True, Message.pinned_until < get_wib_time()).all()
    if expired_pins:
        for msg in expired_pins:
            msg.is_pinned = False
            msg.pinned_until = None
        db.session.commit()

    pinned_messages = Message.query\
        .filter_by(is_hidden=False, is_pinned=True, parent_id=None)\
        .order_by(Message.upvotes.desc(), Message.timestamp.desc())\
        .all()

    messages = Message.query\
        .filter_by(is_hidden=False, is_pinned=False, parent_id=None)\
        .order_by(Message.timestamp.desc())\
        .paginate(page=page, per_page=per_page, error_out=False)
    
    return render_template('index.html', messages=messages, pinned_messages=pinned_messages)

def get_city_from_ip(ip):
    if ip in ('127.0.0.1', 'localhost', '::1') or ip.startswith('192.168.') or ip.startswith('10.'):
        return "Lokal"
    try:
        req = urllib.request.Request(f'http://ip-api.com/json/{ip}?fields=city,regionName,isp', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=2) as response:
            data = json.loads(response.read().decode())
            
            parts = []
            if data.get('city'):
                parts.append(data['city'])
            if data.get('regionName') and data.get('regionName') != data.get('city'):
                parts.append(data['regionName'])
                
            loc = ", ".join(parts) if parts else ""
            isp = data.get('isp', '')
            
            if loc and isp:
                return f"{loc} - {isp}"
            elif loc:
                return loc
            elif isp:
                return isp
    except Exception:
        pass
    return "Tidak diketahui"

@app.route('/api/submit', methods=['POST'])
def submit_message():
    """Submit a new anonymous message to the public board."""
    # Rate limiting: maks 5 pesan per IP per menit
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr).split(',')[0].strip()
    if is_rate_limited(client_ip):
        return jsonify({'error': f'Terlalu banyak pesan. Tunggu sebentar sebelum mengirim lagi.'}), 429

    data = request.get_json()
    content = data.get('message', '').strip()

    if not content:
        return jsonify({'error': 'Pesan tidak boleh kosong.'}), 400

    if len(content) > 500:
        return jsonify({'error': 'Pesan maksimal 500 karakter.'}), 400

    # Handle reply
    parent_id = data.get('parent_id')
    if parent_id:
        parent = Message.query.get(parent_id)
        if not parent or parent.is_hidden or parent.parent_id is not None:
            return jsonify({'error': 'Pesan induk tidak valid.'}), 400

    import uuid
    secret_token = str(uuid.uuid4())
    location = get_city_from_ip(client_ip)
    
    new_msg = Message(content=content, parent_id=parent_id if parent_id else None, secret_token=secret_token, location=location)
    db.session.add(new_msg)
    db.session.commit()

    # Total only counts top-level visible messages
    total = Message.query.filter_by(is_hidden=False, parent_id=None).count()

    resp = {
        'success':   True,
        'total':     total,
        'parent_id': parent_id,
        'message': {
            'id':          new_msg.id,
            'content':     new_msg.content,
            'time':        new_msg.timestamp.strftime('%H:%M'),
            'date_key':    fmt_date_key(new_msg.timestamp),
            'date_label':  fmt_date_id(new_msg.timestamp),
            'reply_count': 0,
            'upvotes':     0,
            'downvotes':   0,
            'is_pinned':   False,
            'secret_token': secret_token,
            'timestamp_ms': int(new_msg.timestamp.timestamp() * 1000)
        }
    }
    return jsonify(resp)

@app.route('/api/messages/<int:msg_id>/vote', methods=['POST'])
def vote_message(msg_id):
    msg = Message.query.get_or_404(msg_id)
    if msg.is_hidden:
        return jsonify({'error': 'Pesan tidak ditemukan.'}), 404

    data = request.get_json()
    vote_type = data.get('type')
    action = data.get('action', 'vote')

    # Basic tracking with cookie in JS is possible, but here we just process the vote
    # Ideally would use IP tracking like the rate limiter
    if action == 'undo':
        if vote_type == 'up' and msg.upvotes > 0:
            msg.upvotes -= 1
            if msg.upvotes >= 15:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=3)
            elif msg.upvotes >= 10:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=2)
            elif msg.upvotes >= 5:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=1)
            else:
                msg.is_pinned = False
                msg.pinned_until = None
        elif vote_type == 'down' and msg.downvotes > 0:
            msg.downvotes -= 1
            if msg.downvotes < 20 and msg.is_hidden:
                msg.is_hidden = False
    else:
        if vote_type == 'up':
            msg.upvotes += 1
            if msg.upvotes >= 15:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=3)
            elif msg.upvotes >= 10:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=2)
            elif msg.upvotes >= 5:
                msg.is_pinned = True
                msg.pinned_until = get_wib_time() + datetime.timedelta(days=1)
        elif vote_type == 'down':
            msg.downvotes += 1
            if msg.downvotes >= 20:
                msg.is_hidden = True

    db.session.commit()
    
    return jsonify({
        'success': True,
        'upvotes': msg.upvotes,
        'downvotes': msg.downvotes,
        'is_pinned': msg.is_pinned,
        'is_hidden': msg.is_hidden
    })

@app.route('/api/user_delete/<int:msg_id>', methods=['POST'])
def user_delete_message(msg_id):
    """Allow user to delete their own message within 1 minute."""
    data = request.get_json()
    token = data.get('token')
    
    msg = Message.query.get_or_404(msg_id)
    
    if not token or msg.secret_token != token:
        return jsonify({'error': 'Tidak ada akses.'}), 403
        
    age = (get_wib_time() - msg.timestamp).total_seconds()
    if age > 60:
        return jsonify({'error': 'Waktu untuk menghapus (1 menit) sudah habis.'}), 400
        
    db.session.delete(msg)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/messages')
def get_messages():
    """Fetch top-level messages for live polling. Supports ?since=<id>."""
    since_id = request.args.get('since', 0, type=int)

    query = Message.query.filter_by(is_hidden=False, parent_id=None)
    if since_id:
        query = query.filter(Message.id > since_id)

    msgs  = query.order_by(Message.timestamp.desc()).all()
    
    # We need all visible top-level messages to provide visible_ids and reply_counts
    all_visible = Message.query.filter_by(is_hidden=False, parent_id=None).all()
    total = len(all_visible)
    visible_ids = [m.id for m in all_visible]
    reply_counts = {m.id: m.visible_reply_count for m in all_visible}
    vote_counts = {m.id: {'u': m.upvotes, 'd': m.downvotes, 'p': m.is_pinned} for m in all_visible}

    # Also need visible IDs for replies so the client can remove deleted replies
    visible_replies = [m[0] for m in db.session.query(Message.id).filter(Message.is_hidden==False, Message.parent_id.isnot(None)).all()]

    return jsonify({
        'messages': [
            {
                'id':          m.id,
                'content':     m.content,
                'time':        m.timestamp.strftime('%H:%M'),
                'date_key':    fmt_date_key(m.timestamp),
                'date_label':  fmt_date_id(m.timestamp),
                'reply_count': m.visible_reply_count,
                'upvotes':     m.upvotes,
                'downvotes':   m.downvotes,
                'is_pinned':   m.is_pinned,
            }
            for m in msgs
        ],
        'total': total,
        'visible_ids': visible_ids,
        'visible_replies': visible_replies,
        'reply_counts': reply_counts,
        'vote_counts': vote_counts
    })

@app.route('/api/messages_by_ids', methods=['POST'])
def get_messages_by_ids():
    """Fetch specific messages by their IDs (used when a message is unhidden)."""
    ids = request.json.get('ids', [])
    if not ids:
        return jsonify({'messages': []})
        
    msgs = Message.query.filter(Message.id.in_(ids)).all()
    return jsonify({
        'messages': [
            {
                'id':          m.id,
                'content':     m.content,
                'time':        m.timestamp.strftime('%H:%M'),
                'date_key':    fmt_date_key(m.timestamp),
                'date_label':  fmt_date_id(m.timestamp),
                'reply_count': m.visible_reply_count,
                'parent_id':   m.parent_id
            }
            for m in msgs
        ]
    })


@app.route('/api/replies/<int:msg_id>')
def get_replies(msg_id):
    """Fetch all visible replies for a given message."""
    parent = Message.query.get_or_404(msg_id)
    replies = parent.replies.filter_by(is_hidden=False)\
        .order_by(Message.timestamp.asc()).all()
    return jsonify({
        'replies': [
            {
                'id':      r.id,
                'content': r.content,
                'time':    r.timestamp.strftime('%H:%M'),
            }
            for r in replies
        ]
    })


@app.route('/api/stats')
def get_stats():
    """Quick endpoint for real-time total count."""
    total = Message.query.filter_by(is_hidden=False).count()
    return jsonify({'total': total})

# ─── Admin Routes ──────────────────────────────────────────────────────────────

@app.route('/api/admin/messages')
@login_required
def admin_api_messages():
    """Real-time polling for admin dashboard."""
    since_id = request.args.get('since', 0, type=int)
    filter_mode = request.args.get('filter', 'all')
    
    query = Message.query.filter(Message.id > since_id)
    if filter_mode == 'visible':
        query = query.filter_by(is_hidden=False)
    elif filter_mode == 'hidden':
        query = query.filter_by(is_hidden=True)
        
    msgs = query.order_by(Message.timestamp.desc()).all()
    
    return jsonify({
        'messages': [
            {
                'id': m.id,
                'content': m.content,
                'time': m.timestamp.strftime('%d %b %Y, %H:%M'),
                'is_hidden': m.is_hidden,
                'location': m.location
            } for m in msgs
        ],
        'stats': {
            'total': Message.query.count(),
            'visible': Message.query.filter_by(is_hidden=False).count(),
            'hidden': Message.query.filter_by(is_hidden=True).count()
        }
    })

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('admin'))
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('admin'))
        else:
            flash('Username atau password salah.', 'danger')
    return render_template('login.html')

@app.route('/admin')
@login_required
def admin():
    """Admin dashboard - sees ALL messages including hidden ones."""
    page = request.args.get('page', 1, type=int)
    per_page = 20
    filter_mode = request.args.get('filter', 'all')

    query = Message.query
    if filter_mode == 'hidden':
        query = query.filter_by(is_hidden=True)
    elif filter_mode == 'visible':
        query = query.filter_by(is_hidden=False)

    messages = query.order_by(Message.timestamp.desc())\
        .paginate(page=page, per_page=per_page, error_out=False)

    total_visible = Message.query.filter_by(is_hidden=False).count()
    total_hidden = Message.query.filter_by(is_hidden=True).count()

    return render_template('admin.html',
                           messages=messages,
                           filter_mode=filter_mode,
                           total_visible=total_visible,
                           total_hidden=total_hidden)

@app.route('/admin/delete/<int:msg_id>', methods=['POST'])
@login_required
def delete_message(msg_id):
    """Permanently delete a message."""
    msg = Message.query.get_or_404(msg_id)
    db.session.delete(msg)
    db.session.commit()
    total_visible = Message.query.filter_by(is_hidden=False).count()
    total_hidden  = Message.query.filter_by(is_hidden=True).count()
    return jsonify({
        'success': True,
        'stats': {
            'total':   total_visible + total_hidden,
            'visible': total_visible,
            'hidden':  total_hidden,
        }
    })

@app.route('/admin/toggle/<int:msg_id>', methods=['POST'])
@login_required
def toggle_message(msg_id):
    """Hide or unhide a message from public view."""
    msg = Message.query.get_or_404(msg_id)
    msg.is_hidden = not msg.is_hidden
    db.session.commit()
    total_visible = Message.query.filter_by(is_hidden=False).count()
    total_hidden  = Message.query.filter_by(is_hidden=True).count()
    return jsonify({
        'success':   True,
        'is_hidden': msg.is_hidden,
        'stats': {
            'total':   total_visible + total_hidden,
            'visible': total_visible,
            'hidden':  total_hidden,
        }
    })

# ─── Feedback Routes ──────────────────────────────────────────────────────────

@app.route('/feedback')
def feedback_board():
    page = request.args.get('page', 1, type=int)
    per_page = 20
    feedbacks = Feedback.query.filter_by(is_hidden=False)\
        .order_by(Feedback.timestamp.desc())\
        .paginate(page=page, per_page=per_page, error_out=False)
    return render_template('feedback.html', feedbacks=feedbacks)

@app.route('/api/submit_feedback', methods=['POST'])
def submit_feedback():
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr).split(',')[0].strip()
    if is_feedback_rate_limited(client_ip):
        return jsonify({'error': 'Batas maksimal 5 laporan bug/fitur per hari. Silakan coba lagi besok.'}), 429
        
    data = request.get_json()
    content = data.get('content', '').strip()
    if not content:
        return jsonify({'error': 'Pesan tidak boleh kosong.'}), 400
        
    location = get_city_from_ip(client_ip)
    
    new_fb = Feedback(content=content, location=location)
    db.session.add(new_fb)
    db.session.commit()
    
    return jsonify({
        'success': True,
        'feedback': {
            'id': new_fb.id,
            'content': new_fb.content,
            'timestamp_ms': int(new_fb.timestamp.timestamp() * 1000),
        }
    })

@app.route('/admin/feedback')
@login_required
def admin_feedback():
    page = request.args.get('page', 1, type=int)
    per_page = 20
    filter_mode = request.args.get('filter', 'all')

    query = Feedback.query
    if filter_mode == 'hidden':
        query = query.filter_by(is_hidden=True)
    elif filter_mode == 'visible':
        query = query.filter_by(is_hidden=False)
        
    feedbacks = query.order_by(Feedback.timestamp.desc())\
        .paginate(page=page, per_page=per_page, error_out=False)
        
    return render_template('admin_feedback.html', feedbacks=feedbacks, filter_mode=filter_mode)

@app.route('/admin/feedback/reply/<int:fb_id>', methods=['POST'])
@login_required
def admin_reply_feedback(fb_id):
    fb = Feedback.query.get_or_404(fb_id)
    data = request.get_json()
    reply_content = data.get('reply', '').strip()
    
    if reply_content:
        fb.admin_reply = reply_content
        fb.admin_reply_timestamp = get_wib_time()
    else:
        fb.admin_reply = None
        fb.admin_reply_timestamp = None
        
    db.session.commit()
    return jsonify({'success': True})

@app.route('/admin/feedback/toggle/<int:fb_id>', methods=['POST'])
@login_required
def toggle_feedback(fb_id):
    fb = Feedback.query.get_or_404(fb_id)
    fb.is_hidden = not fb.is_hidden
    db.session.commit()
    return jsonify({'success': True, 'is_hidden': fb.is_hidden})

@app.route('/admin/feedback/delete/<int:fb_id>', methods=['POST'])
@login_required
def delete_feedback(fb_id):
    fb = Feedback.query.get_or_404(fb_id)
    db.session.delete(fb)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# ─── Backup ────────────────────────────────────────────────────────────────────

def backup_messages():
    """Monthly backup of all messages to a text file."""
    with app.app_context():
        messages = Message.query.order_by(Message.timestamp).all()
        backup_dir = os.path.join(app.root_path, 'backups')
        os.makedirs(backup_dir, exist_ok=True)
        filename = f"backup_{datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.txt"
        backup_path = os.path.join(backup_dir, filename)
        with open(backup_path, 'w', encoding='utf-8') as f:
            f.write(f"=== Menfess Backup - {datetime.datetime.now()} ===\n\n")
            for msg in messages:
                status = "[HIDDEN]" if msg.is_hidden else "[VISIBLE]"
                f.write(f"{status} [{msg.timestamp}] (ID:{msg.id})\n{msg.content}\n\n")
        print(f"[Backup] Saved to {backup_path}")

# ─── Init ──────────────────────────────────────────────────────────────────────

with app.app_context():
    db.create_all()

    # Aktifkan WAL mode untuk SQLite — concurrent reads & writes lebih baik
    from sqlalchemy import text, inspect
    with db.engine.connect() as conn:
        conn.execute(text('PRAGMA journal_mode=WAL'))
        conn.execute(text('PRAGMA synchronous=NORMAL'))
        conn.execute(text('PRAGMA cache_size=-16000'))  # ~16MB cache

        # Migrasi: tambah kolom parent_id & secret_token
        inspector = inspect(db.engine)
        existing_cols = [c['name'] for c in inspector.get_columns('message')]
        if 'parent_id' not in existing_cols:
            conn.execute(text('ALTER TABLE message ADD COLUMN parent_id INTEGER REFERENCES message(id)'))
            print('[Migration] Added parent_id column to message table.')
        if 'secret_token' not in existing_cols:
            conn.execute(text('ALTER TABLE message ADD COLUMN secret_token VARCHAR(36)'))
            print('[Migration] Added secret_token column to message table.')
        if 'location' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN location VARCHAR(100) DEFAULT 'Tidak diketahui'"))
            print('[Migration] Added location column to message table.')
        if 'upvotes' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN upvotes INTEGER DEFAULT 0"))
            print('[Migration] Added upvotes column to message table.')
        if 'downvotes' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN downvotes INTEGER DEFAULT 0"))
            print('[Migration] Added downvotes column to message table.')
        if 'is_pinned' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN is_pinned BOOLEAN DEFAULT 0"))
            print('[Migration] Added is_pinned column to message table.')
        if 'pinned_until' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN pinned_until DATETIME"))
            print('[Migration] Added pinned_until column to message table.')

        conn.commit()

    admin_username = os.environ.get('ADMIN_USERNAME', 'admin')
    admin_password = os.environ.get('ADMIN_PASSWORD', 'password')

    admin_user = User.query.first()
    if not admin_user:
        hashed_pw = generate_password_hash(admin_password, method='pbkdf2:sha256')
        admin_user = User(username=admin_username, password=hashed_pw)
        db.session.add(admin_user)
        db.session.commit()
    else:
        admin_user.username = admin_username
        admin_user.password = generate_password_hash(admin_password, method='pbkdf2:sha256')
        db.session.commit()

if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    scheduler = BackgroundScheduler()
    scheduler.add_job(func=backup_messages, trigger='interval', days=30)
    scheduler.start()
    try:
        app.run(debug=debug_mode, port=5000)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()

