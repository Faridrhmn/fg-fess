from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from apscheduler.schedulers.background import BackgroundScheduler
import datetime
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
# Menggunakan os.urandom untuk mengenkripsi sesi (cookies login) secara acak dan sangat aman
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(24))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///messages.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

@app.after_request
def add_header(response):
    """
    Add headers to prevent browser caching so that users cannot use the back button
    to view protected pages after logging out.
    """
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, post-check=0, pre-check=0, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# Models
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(150), nullable=False)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

import random

try:
    from langdetect import detect
except ImportError:
    detect = lambda text: 'id'

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    vader_analyzer = SentimentIntensityAnalyzer()
except ImportError:
    vader_analyzer = None

# Setup Local AI Model for Offline & Fast Generation
# Dihapus karena model transformers terlalu berat untuk server 2 core
sentiment_analyzer = None

# Free AI / Contextual Reply Function using Local Model (Bilingual)
def generate_reply(message_text):
    en_neutral = [
        "Hello! Thank you so much for dropping by and leaving a message. 💌",
        "So glad to see you here! Your message has been safely saved. 🌻",
        "Thanks for leaving your mark here. Hope you have a wonderful day! 📝",
        "Message received! Thank you so much for your time. 🕊️"
    ]
    return random.choice(en_neutral)

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/submit', methods=['POST'])
def submit_message():
    data = request.get_json()
    message_content = data.get('message', '').strip()
    
    if not message_content:
        return jsonify({'error': 'Message cannot be empty'}), 400
        
    new_message = Message(content=message_content)
    db.session.add(new_message)
    db.session.commit()
    
    reply = generate_reply(message_content)
    return jsonify({'reply': reply})

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
            flash('Incorrect username or password.', 'danger')
            
    return render_template('login.html')

@app.route('/admin')
@login_required
def admin():
    messages = Message.query.order_by(Message.timestamp.desc()).all()
    return render_template('admin.html', messages=messages)

@app.route('/admin/delete/<int:msg_id>', methods=['POST'])
@login_required
def delete_message(msg_id):
    msg = Message.query.get_or_404(msg_id)
    db.session.delete(msg)
    db.session.commit()
    flash('Message successfully deleted.', 'success')
    return redirect(url_for('admin'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# Backup Logic
def backup_messages():
    with app.app_context():
        messages = Message.query.all()
        backup_path = os.path.join(app.root_path, 'backups.txt')
        with open(backup_path, 'a', encoding='utf-8') as f:
            f.write(f"\n--- Backup on {datetime.datetime.now()} ---\n")
            for msg in messages:
                f.write(f"[{msg.timestamp}] {msg.content}\n")
        print(f"Backup completed at {datetime.datetime.now()}")

with app.app_context():
    db.create_all()
    # Create or update default admin user from environment variables
    admin_username = os.environ.get('ADMIN_USERNAME', 'admin')
    admin_password = os.environ.get('ADMIN_PASSWORD', 'defaultpassword')
    
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
    # Schedule backup every 1 month (approx 30 days)
    scheduler = BackgroundScheduler()
    scheduler.add_job(func=backup_messages, trigger="interval", days=30)
    scheduler.start()
    
    try:
        app.run(debug=True, port=5000)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
