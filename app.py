import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, jsonify, redirect, url_for, flash

from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit
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
app.config['UPLOAD_FOLDER'] = os.path.join(app.root_path, 'static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024  # 5MB max-limit
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

socketio = SocketIO(app, cors_allowed_origins="*")


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
    image_filename = db.Column(db.String(255), nullable=True)
    reports = db.Column(db.Integer, default=0)

    # Relationships
    replies   = db.relationship('Message',
                                backref=db.backref('parent', remote_side='Message.id'),
                                lazy='dynamic',
                                foreign_keys='Message.parent_id')

    @property
    def visible_reply_count(self):
        return self.replies.filter_by(is_hidden=False).count()

class MessageReport(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id', ondelete='CASCADE'), nullable=False)
    reason = db.Column(db.String(255), nullable=False)
    timestamp = db.Column(db.DateTime, default=get_wib_time)

    message = db.relationship('Message', backref=db.backref('reports_list', lazy=True, cascade='all, delete'))


class MessageReaction(db.Model):
    """Stores emoji reactions per message. One reaction per emoji per IP."""
    __tablename__ = 'message_reaction'
    id         = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id', ondelete='CASCADE'), nullable=False)
    emoji      = db.Column(db.String(10), nullable=False)   # e.g. '❤️', '😂'
    client_ip  = db.Column(db.String(45), nullable=False)   # IPv4/IPv6
    timestamp  = db.Column(db.DateTime, default=get_wib_time)

    message = db.relationship('Message', backref=db.backref('reactions', lazy=True, cascade='all, delete'))

    # Ensure one reaction per emoji per IP per message
    __table_args__ = (db.UniqueConstraint('message_id', 'emoji', 'client_ip', name='uq_reaction'),)

class Poll(db.Model):
    __tablename__ = 'poll'
    id         = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id', ondelete='CASCADE'), nullable=False, unique=True)
    created_at = db.Column(db.DateTime, default=get_wib_time)

    message = db.relationship('Message', backref=db.backref('poll', uselist=False, cascade='all, delete'))
    options = db.relationship('PollOption', backref='poll', lazy=True, cascade='all, delete-orphan', order_by='PollOption.id')
    votes   = db.relationship('PollVote', backref='poll', lazy=True, cascade='all, delete-orphan')

class PollOption(db.Model):
    __tablename__ = 'poll_option'
    id         = db.Column(db.Integer, primary_key=True)
    poll_id    = db.Column(db.Integer, db.ForeignKey('poll.id', ondelete='CASCADE'), nullable=False)
    text       = db.Column(db.String(100), nullable=False)
    vote_count = db.Column(db.Integer, default=0)

class PollVote(db.Model):
    __tablename__ = 'poll_vote'
    id          = db.Column(db.Integer, primary_key=True)
    poll_id     = db.Column(db.Integer, db.ForeignKey('poll.id', ondelete='CASCADE'), nullable=False)
    option_id   = db.Column(db.Integer, db.ForeignKey('poll_option.id', ondelete='CASCADE'), nullable=False)
    voter_token = db.Column(db.String(64), nullable=False)
    client_ip   = db.Column(db.String(45), nullable=True)
    timestamp   = db.Column(db.DateTime, default=get_wib_time)

    __table_args__ = (db.UniqueConstraint('poll_id', 'voter_token', name='uq_poll_vote_token'),)

class Feedback(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=get_wib_time)
    location = db.Column(db.String(100), default="Tidak diketahui")
    admin_reply = db.Column(db.Text, nullable=True)
    admin_reply_timestamp = db.Column(db.DateTime, nullable=True)
    is_hidden = db.Column(db.Boolean, default=False)

class Announcement(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=get_wib_time)

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
    
    visible_ids = [m.id for m in pinned_messages] + [m.id for m in messages.items]
    reaction_counts = _get_reactions_bulk(visible_ids)
    voter_token = request.cookies.get('fgfess_voter_id') or request.headers.get('X-Voter-Token')
    needs_cookie = False
    if not voter_token:
        import uuid
        voter_token = f"vtr_{uuid.uuid4().hex}"
        needs_cookie = True

    polls = _get_polls_bulk(visible_ids, voter_token)

    rendered = render_template('index.html', messages=messages, pinned_messages=pinned_messages, reaction_counts=reaction_counts, polls=polls)
    resp = app.make_response(rendered)
    if needs_cookie:
        resp.set_cookie('fgfess_voter_id', voter_token, max_age=31536000, samesite='Lax')
    return resp

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

    if request.is_json:
        data = request.get_json()
    else:
        data = request.form

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

    # Poll validation
    poll_options_raw = data.get('poll_options')
    poll_options = []
    if poll_options_raw and not parent_id:
        if isinstance(poll_options_raw, str):
            try:
                poll_options = json.loads(poll_options_raw)
            except Exception:
                poll_options = []
        elif isinstance(poll_options_raw, list):
            poll_options = poll_options_raw

        poll_options = [str(opt).strip()[:80] for opt in poll_options if str(opt).strip()]
        if len(poll_options) == 1:
            return jsonify({'error': 'Polling minimal harus memiliki 2 pilihan.'}), 400
        if len(poll_options) > 5:
            poll_options = poll_options[:5]

    import uuid
    secret_token = str(uuid.uuid4())
    location = get_city_from_ip(client_ip)
    
    image_filename = None
    if 'image' in request.files:
        image = request.files['image']
        if image and image.filename:
            from werkzeug.utils import secure_filename
            from PIL import Image
            import io
            ext = image.filename.rsplit('.', 1)[-1].lower()
            if ext in {'png', 'jpg', 'jpeg', 'gif', 'webp'}:
                img_bytes = image.read()
                try:
                    img = Image.open(io.BytesIO(img_bytes))
                    if img.mode in ("RGBA", "P") and ext != 'gif':
                        img = img.convert("RGB")
                    
                    filename = str(uuid.uuid4()) + '.webp'
                    save_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                    
                    # Resize if too large
                    img.thumbnail((1200, 1200))
                    
                    # Compress and save as WebP
                    img.save(save_path, "WEBP", quality=75)
                    image_filename = filename
                except Exception as e:
                    print(f"Image compression error: {e}")
                    filename = secure_filename(str(uuid.uuid4()) + '.' + ext)
                    image_filename = filename
                    image.seek(0)
                    image.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
    
    new_msg = Message(content=content, parent_id=parent_id if parent_id else None, secret_token=secret_token, location=location, image_filename=image_filename)
    db.session.add(new_msg)

    poll_obj = None
    if not parent_id and len(poll_options) >= 2:
        poll_obj = Poll(message=new_msg)
        db.session.add(poll_obj)
        for opt_text in poll_options:
            opt = PollOption(poll=poll_obj, text=opt_text, vote_count=0)
            db.session.add(opt)

    db.session.commit()

    # Total only counts top-level visible messages
    total = Message.query.filter_by(is_hidden=False, parent_id=None).count()
    unpinned_total = Message.query.filter_by(is_hidden=False, is_pinned=False, parent_id=None).count()

    voter_token = request.cookies.get('fgfess_voter_id') or request.headers.get('X-Voter-Token')
    poll_dict = _format_poll_dict(poll_obj, voter_token) if poll_obj else None
    poll_dict_public = _format_poll_dict(poll_obj, None) if poll_obj else None

    resp = {
        'success':   True,
        'total':     total,
        'unpinned_total': unpinned_total,
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
            'timestamp_ms': int(new_msg.timestamp.timestamp() * 1000),
            'image_filename': image_filename,
            'poll':        poll_dict
        }
    }
    if parent_id:
        resp['message']['parent_id'] = parent_id
        
        # Omit secret_token for broadcast
        public_msg = resp['message'].copy()
        public_msg.pop('secret_token', None)
        
        socketio.emit('new_reply', public_msg)
    else:
        # Omit secret_token for broadcast
        public_msg = resp['message'].copy()
        public_msg.pop('secret_token', None)
        public_msg['poll'] = poll_dict_public
        
        # Also include total stats for top-level message events
        socketio.emit('new_message', {
            'message': public_msg,
            'total': total,
            'unpinned_total': unpinned_total
        })
        
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
    
    resp = {
        'success': True,
        'upvotes': msg.upvotes,
        'downvotes': msg.downvotes,
        'is_pinned': msg.is_pinned,
        'is_hidden': msg.is_hidden
    }
    socketio.emit('update_vote', {'id': msg_id, 'counts': resp})
    return jsonify(resp)


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
    
    total = Message.query.filter_by(is_hidden=False, parent_id=None).count()
    unpinned_total = Message.query.filter_by(is_hidden=False, is_pinned=False, parent_id=None).count()
    
    socketio.emit('message_deleted', {'id': msg_id, 'total': total, 'unpinned_total': unpinned_total})
    return jsonify({'success': True})

@app.route('/api/messages/<int:msg_id>/report', methods=['POST'])
def report_message(msg_id):
    msg = Message.query.get_or_404(msg_id)
    if msg.is_hidden:
        return jsonify({'error': 'Pesan tidak ditemukan.'}), 404
    
    data = request.get_json() or {}
    reason = data.get('reason', 'Lainnya')
        
    msg.reports += 1
    new_report = MessageReport(message_id=msg.id, reason=reason[:250])
    db.session.add(new_report)
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
    
    total = Message.query.filter_by(is_hidden=False, parent_id=None).count()
    unpinned_total = Message.query.filter_by(is_hidden=False, is_pinned=False, parent_id=None).count()

    msg_ids = [m.id for m in msgs]
    reactions = _get_reactions_bulk(msg_ids)
    voter_token = request.cookies.get('fgfess_voter_id') or request.headers.get('X-Voter-Token')
    polls = _get_polls_bulk(msg_ids, voter_token)

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
                'image_filename': m.image_filename,
                'reactions':   reactions.get(m.id, {}),
                'poll':        polls.get(m.id)
            }
            for m in msgs
        ],
        'total': total,
        'unpinned_total': unpinned_total
    })

@app.route('/api/messages_by_ids', methods=['POST'])
def get_messages_by_ids():
    """Fetch specific messages by their IDs (used when a message is unhidden)."""
    ids = request.json.get('ids', [])
    if not ids:
        return jsonify({'messages': []})
        
    msgs = Message.query.filter(Message.id.in_(ids)).all()
    voter_token = request.cookies.get('fgfess_voter_id') or request.headers.get('X-Voter-Token')
    polls = _get_polls_bulk([m.id for m in msgs], voter_token)

    return jsonify({
        'messages': [
            {
                'id':          m.id,
                'content':     m.content,
                'time':        m.timestamp.strftime('%H:%M'),
                'date_key':    fmt_date_key(m.timestamp),
                'date_label':  fmt_date_id(m.timestamp),
                'reply_count': m.visible_reply_count,
                'parent_id':   m.parent_id,
                'image_filename': m.image_filename,
                'poll':        polls.get(m.id)
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


EMOJI_LIST = ['❤️', '😂', '😮', '😢', '😡', '👍']

@app.route('/api/messages/<int:msg_id>/react', methods=['POST'])
def react_message(msg_id):
    """Toggle an emoji reaction on a message."""
    msg = Message.query.get_or_404(msg_id)
    if msg.is_hidden:
        return jsonify({'error': 'Pesan tidak ditemukan.'}), 404

    data = request.get_json() or {}
    emoji = data.get('emoji', '')
    if emoji not in EMOJI_LIST:
        return jsonify({'error': 'Emoji tidak valid.'}), 400

    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr).split(',')[0].strip()

    existing = MessageReaction.query.filter_by(
        message_id=msg_id, emoji=emoji, client_ip=client_ip
    ).first()

    if existing:
        db.session.delete(existing)
        action = 'removed'
    else:
        new_reaction = MessageReaction(message_id=msg_id, emoji=emoji, client_ip=client_ip)
        db.session.add(new_reaction)
        action = 'added'

    db.session.commit()

    # Return updated counts for all emojis on this message
    counts = _get_reaction_counts(msg_id)
    socketio.emit('update_reaction', {'id': msg_id, 'reactions': counts})
    return jsonify({'success': True, 'action': action, 'reactions': counts})


@app.route('/api/polls/<int:poll_id>/vote', methods=['POST'])
def vote_poll(poll_id):
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr).split(',')[0].strip()
    poll = Poll.query.get_or_404(poll_id)

    data = request.get_json() or {}
    option_id = data.get('option_id')
    if not option_id:
        return jsonify({'error': 'Pilihan tidak valid.'}), 400

    option = PollOption.query.filter_by(id=option_id, poll_id=poll.id).first()
    if not option:
        return jsonify({'error': 'Pilihan tidak ditemukan.'}), 404

    # Resolve unique device/browser voter token
    voter_token = data.get('voter_token') or request.cookies.get('fgfess_voter_id') or request.headers.get('X-Voter-Token')
    if not voter_token:
        import uuid
        voter_token = f"vtr_{uuid.uuid4().hex}"

    existing_vote = PollVote.query.filter_by(poll_id=poll.id, voter_token=voter_token).first()
    if existing_vote:
        if existing_vote.option_id == option.id:
            # Clicked the same option they already picked
            poll_user = _format_poll_dict(poll, voter_token)
            resp = jsonify({'success': True, 'poll': poll_user, 'voter_token': voter_token, 'message': 'Kamu sudah memilih opsi ini.'})
            resp.set_cookie('fgfess_voter_id', voter_token, max_age=31536000, samesite='Lax')
            return resp

        # Change vote to the newly selected option
        old_option = PollOption.query.filter_by(id=existing_vote.option_id, poll_id=poll.id).first()
        if old_option and old_option.vote_count > 0:
            old_option.vote_count -= 1
        existing_vote.option_id = option.id
        existing_vote.client_ip = client_ip
        existing_vote.timestamp = get_wib_time()
        option.vote_count += 1
        db.session.commit()
    else:
        try:
            vote = PollVote(poll_id=poll.id, option_id=option.id, voter_token=voter_token, client_ip=client_ip)
            option.vote_count += 1
            db.session.add(vote)
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            return jsonify({'error': 'Gagal mencatat suara.'}), 500

    # Format updated poll for public broadcast and for user response
    poll_public = _format_poll_dict(poll, None)
    socketio.emit('update_poll', poll_public)

    poll_user = _format_poll_dict(poll, voter_token)
    resp = jsonify({'success': True, 'poll': poll_user, 'voter_token': voter_token})
    resp.set_cookie('fgfess_voter_id', voter_token, max_age=31536000, samesite='Lax')
    return resp


def _format_poll_dict(poll, voter_token=None):
    if not poll:
        return None
    # Calculate vote counts dynamically from PollVote
    vote_rows = db.session.query(
        PollVote.option_id, db.func.count(PollVote.id)
    ).filter(PollVote.poll_id == poll.id).group_by(PollVote.option_id).all()
    vote_counts = dict(vote_rows)
    total_votes = sum(vote_counts.values())

    user_voted_option_id = None
    if voter_token:
        user_vote = PollVote.query.filter_by(poll_id=poll.id, voter_token=voter_token).first()
        if user_vote:
            user_voted_option_id = user_vote.option_id

    return {
        'id': poll.id,
        'message_id': poll.message_id,
        'total_votes': total_votes,
        'user_voted_option_id': user_voted_option_id,
        'options': [
            {
                'id': opt.id,
                'text': opt.text,
                'vote_count': vote_counts.get(opt.id, 0),
                'percentage': round((vote_counts.get(opt.id, 0) / total_votes * 100), 1) if total_votes > 0 else 0
            }
            for opt in poll.options
        ]
    }


def _get_polls_bulk(msg_ids, voter_token=None):
    if not msg_ids:
        return {}
    polls = Poll.query.filter(Poll.message_id.in_(msg_ids)).all()
    if not polls:
        return {}

    poll_ids = [p.id for p in polls]

    # Fetch all vote counts for these polls in one efficient query
    vote_rows = db.session.query(
        PollVote.poll_id, PollVote.option_id, db.func.count(PollVote.id)
    ).filter(PollVote.poll_id.in_(poll_ids)).group_by(PollVote.poll_id, PollVote.option_id).all()

    poll_vote_counts = {}
    for pid, opt_id, cnt in vote_rows:
        poll_vote_counts.setdefault(pid, {})[opt_id] = cnt

    user_votes = {}
    if voter_token:
        votes = PollVote.query.filter(PollVote.poll_id.in_(poll_ids), PollVote.voter_token == voter_token).all()
        for v in votes:
            user_votes[v.poll_id] = v.option_id

    result = {}
    for poll in polls:
        counts = poll_vote_counts.get(poll.id, {})
        total_votes = sum(counts.values())
        result[poll.message_id] = {
            'id': poll.id,
            'message_id': poll.message_id,
            'total_votes': total_votes,
            'user_voted_option_id': user_votes.get(poll.id),
            'options': [
                {
                    'id': opt.id,
                    'text': opt.text,
                    'vote_count': counts.get(opt.id, 0),
                    'percentage': round((counts.get(opt.id, 0) / total_votes * 100), 1) if total_votes > 0 else 0
                }
                for opt in poll.options
            ]
        }
    return result



def _get_reaction_counts(msg_id):
    """Return {emoji: count} dict for a message."""
    rows = db.session.query(
        MessageReaction.emoji,
        db.func.count(MessageReaction.id).label('cnt')
    ).filter(
        MessageReaction.message_id == msg_id
    ).group_by(MessageReaction.emoji).all()
    return {row.emoji: row.cnt for row in rows}


def _get_reactions_bulk(msg_ids):
    """Return {msg_id: {emoji: count}} for a list of message IDs."""
    if not msg_ids:
        return {}
    rows = db.session.query(
        MessageReaction.message_id,
        MessageReaction.emoji,
        db.func.count(MessageReaction.id).label('cnt')
    ).filter(
        MessageReaction.message_id.in_(msg_ids)
    ).group_by(MessageReaction.message_id, MessageReaction.emoji).all()

    result = {}
    for row in rows:
        result.setdefault(row.message_id, {})[row.emoji] = row.cnt
    return result


@app.route('/api/announcement')
def get_announcement():
    ann = Announcement.query.order_by(Announcement.timestamp.desc()).first()
    if ann:
        age = (get_wib_time() - ann.timestamp).total_seconds()
        if age <= 86400: # 24 hours
            return jsonify({'active': True, 'id': ann.id, 'content': ann.content})
    return jsonify({'active': False})

@app.route('/api/trending_hashtags')
def get_trending_hashtags():
    """Parse #hashtags from all visible messages and return top trending."""
    import re
    # Only look at top-level visible messages from the last 7 days
    since = get_wib_time() - datetime.timedelta(days=7)
    messages = Message.query.filter(
        Message.is_hidden == False,
        Message.parent_id == None,
        Message.timestamp >= since
    ).all()

    hashtag_counts = {}
    for msg in messages:
        tags = re.findall(r'#(\w+)', msg.content, re.UNICODE)
        for tag in tags:
            tag_lower = tag.lower()
            hashtag_counts[tag_lower] = hashtag_counts.get(tag_lower, 0) + 1

    # Sort by count descending, take top 10
    sorted_tags = sorted(hashtag_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    return jsonify({
        'hashtags': [{'tag': tag, 'count': count} for tag, count in sorted_tags]
    })

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
    
    reported_msgs = Message.query.filter(Message.reports > 0).all()
    reported_updates = {
        m.id: {
            'reports': m.reports,
            'report_reasons': [r.reason for r in m.reports_list]
        } for m in reported_msgs
    }

    return jsonify({
        'messages': [
            {
                'id': m.id,
                'content': m.content,
                'time': m.timestamp.strftime('%d %b %Y, %H:%M'),
                'is_hidden': m.is_hidden,
                'location': m.location,
                'image_filename': m.image_filename,
                'reports': m.reports,
                'report_reasons': [r.reason for r in m.reports_list] if m.reports > 0 else []
            } for m in msgs
        ],
        'stats': {
            'total': Message.query.count(),
            'visible': Message.query.filter_by(is_hidden=False).count(),
            'hidden': Message.query.filter_by(is_hidden=True).count()
        },
        'reported_updates': reported_updates
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
    resp = jsonify({
        'success': True,
        'stats': {
            'total':   total_visible + total_hidden,
            'visible': total_visible,
            'hidden':  total_hidden,
        }
    })
    
    pub_total = Message.query.filter_by(is_hidden=False, parent_id=None).count()
    pub_unpinned = Message.query.filter_by(is_hidden=False, is_pinned=False, parent_id=None).count()
    socketio.emit('message_deleted', {'id': msg_id, 'total': pub_total, 'unpinned_total': pub_unpinned})
    return resp


@app.route('/admin/toggle/<int:msg_id>', methods=['POST'])
@login_required
def toggle_message(msg_id):
    """Hide or unhide a message from public view."""
    msg = Message.query.get_or_404(msg_id)
    msg.is_hidden = not msg.is_hidden
    db.session.commit()
    total_visible = Message.query.filter_by(is_hidden=False).count()
    total_hidden  = Message.query.filter_by(is_hidden=True).count()
    resp = jsonify({
        'success':   True,
        'is_hidden': msg.is_hidden,
        'stats': {
            'total':   total_visible + total_hidden,
            'visible': total_visible,
            'hidden':  total_hidden,
        }
    })
    if msg.is_hidden:
        pub_total = Message.query.filter_by(is_hidden=False, parent_id=None).count()
        pub_unpinned = Message.query.filter_by(is_hidden=False, is_pinned=False, parent_id=None).count()
        socketio.emit('message_deleted', {'id': msg_id, 'total': pub_total, 'unpinned_total': pub_unpinned}) # Treat hide as delete on client
    else:
        # Client handles unhide by requesting the new message via get_messages_by_ids or we can just tell them to refresh
        socketio.emit('message_unhidden', {'id': msg_id})
    return resp


@app.route('/admin/announcement', methods=['POST'])
@login_required
def create_announcement():
    content = request.json.get('content', '').strip()
    if content:
        ann = Announcement(content=content)
        db.session.add(ann)
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Content empty'})

@app.route('/admin/announcement/delete', methods=['POST'])
@login_required
def delete_announcement():
    Announcement.query.delete()
    db.session.commit()
    return jsonify({'success': True})

@app.route('/admin/messages/<int:msg_id>/clear_reports', methods=['POST'])
@login_required
def clear_reports(msg_id):
    msg = Message.query.get_or_404(msg_id)
    msg.reports = 0
    MessageReport.query.filter_by(message_id=msg.id).delete()
    db.session.commit()
    return jsonify({'success': True})

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

def cleanup_old_images():
    """Delete images older than 7 days."""
    import time
    with app.app_context():
        upload_path = app.config['UPLOAD_FOLDER']
        if not os.path.exists(upload_path):
            return
        now = time.time()
        for filename in os.listdir(upload_path):
            filepath = os.path.join(upload_path, filename)
            if os.path.isfile(filepath):
                if os.stat(filepath).st_mtime < now - 7 * 86400:
                    try:
                        os.remove(filepath)
                        print(f"[Cleanup] Deleted old image {filename}")
                    except Exception as e:
                        print(f"[Cleanup] Error deleting {filename}: {e}")

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
        if 'image_filename' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN image_filename VARCHAR(255)"))
            print('[Migration] Added image_filename column to message table.')
        if 'reports' not in existing_cols:
            conn.execute(text("ALTER TABLE message ADD COLUMN reports INTEGER DEFAULT 0"))
            print('[Migration] Added reports column to message table.')

        if not inspector.has_table('announcement'):
            conn.execute(text('''
                CREATE TABLE announcement (
                    id INTEGER PRIMARY KEY,
                    content TEXT NOT NULL,
                    timestamp DATETIME
                )
            '''))
            print('[Migration] Created announcement table.')

        if not inspector.has_table('message_report'):
            conn.execute(text('''
                CREATE TABLE message_report (
                    id INTEGER PRIMARY KEY,
                    message_id INTEGER NOT NULL,
                    reason VARCHAR(255) NOT NULL,
                    timestamp DATETIME,
                    FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
                )
            '''))
            print('[Migration] Created message_report table.')

        if not inspector.has_table('message_reaction'):
            conn.execute(text('''
                CREATE TABLE message_reaction (
                    id INTEGER PRIMARY KEY,
                    message_id INTEGER NOT NULL,
                    emoji VARCHAR(10) NOT NULL,
                    client_ip VARCHAR(45) NOT NULL,
                    timestamp DATETIME,
                    FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE,
                    UNIQUE(message_id, emoji, client_ip)
                )
            '''))
            print('[Migration] Created message_reaction table.')

        if inspector.has_table('poll_vote'):
            poll_vote_cols = [c['name'] for c in inspector.get_columns('poll_vote')]
            if 'voter_token' not in poll_vote_cols:
                conn.execute(text('DROP TABLE poll_vote'))
                print('[Migration] Dropped old poll_vote table to apply voter_token.')

        conn.execute(text('''
            CREATE TABLE IF NOT EXISTS poll_vote (
                id INTEGER PRIMARY KEY,
                poll_id INTEGER NOT NULL,
                option_id INTEGER NOT NULL,
                voter_token VARCHAR(64) NOT NULL,
                client_ip VARCHAR(45),
                timestamp DATETIME,
                FOREIGN KEY(poll_id) REFERENCES poll(id) ON DELETE CASCADE,
                FOREIGN KEY(option_id) REFERENCES poll_option(id) ON DELETE CASCADE,
                UNIQUE(poll_id, voter_token)
            )
        '''))

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
    scheduler.add_job(func=cleanup_old_images, trigger='interval', days=1)
    scheduler.start()
    try:
        socketio.run(app, debug=debug_mode, port=5002)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()


