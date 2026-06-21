# fg/fess — Anonymous Message Board

Papan pesan anonim sederhana berbasis web. Siapapun bisa mengirim pesan tanpa nama, dan semua pesan tampil secara publik untuk dibaca bersama.

Cocok untuk menfess komunitas, kelas, atau lingkaran pertemanan.

---

## ✨ Fitur

- **📢 Papan Pesan Publik** — semua pesan tampil secara anonim dan bisa dibaca siapa saja
- **⚡ Live Feed** — pesan baru dari orang lain muncul otomatis tanpa reload halaman (polling tiap 5 detik)
- **📅 Pemisah Tanggal** — pesan dikelompokkan per hari dengan label tanggal Bahasa Indonesia
- **📄 Pagination** — 20 pesan per halaman, muncul otomatis saat feed mulai penuh
- **🛡️ Admin Dashboard** — login khusus untuk melihat, menyembunyikan, atau menghapus pesan yang tidak pantas
- **🚫 Rate Limiting** — maksimal 5 pesan per IP per menit untuk mencegah spam
- **💾 Backup Otomatis** — seluruh pesan di-backup ke file teks setiap 30 hari
- **🔒 Session Aman** — login admin berbasis cookie terenkripsi, tidak bisa diakses lintas perangkat

---

## 🛠️ Tech Stack

- **Backend:** Python 3, Flask, Flask-SQLAlchemy, Flask-Login
- **Frontend:** HTML5, Vanilla CSS, Vanilla JavaScript (Fetch API, Polling)
- **Database:** SQLite3 (WAL mode untuk concurrent access)
- **Production Server:** Gunicorn + Nginx
- **Scheduler:** APScheduler (backup bulanan)
- **Environment:** python-dotenv

---

## 📂 Struktur Proyek

```
fg-fess/
├── app.py                  # Aplikasi Flask utama
├── requirements.txt        # Python dependencies
├── .env.example            # Template environment variables
├── .env                    # Konfigurasi (tidak di-commit ke git)
├── instance/               # SQLite database (auto-generated)
├── backups/                # File backup bulanan (auto-generated)
├── static/
│   ├── style.css           # Stylesheet utama
│   ├── script.js           # Logic frontend (live feed, polling)
│   └── favicon.png
└── templates/
    ├── index.html          # Halaman publik (papan pesan)
    ├── login.html          # Halaman login admin
    └── admin.html          # Dashboard admin
```

---

## 🚀 Menjalankan Secara Lokal

### Prasyarat
- Python 3.8+

### 1. Clone & masuk ke folder

```bash
git clone https://github.com/Faridrhmn/fg-fess.git
cd fg-fess
```

### 2. Buat Virtual Environment

```bash
python -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate         # Windows
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Setup environment variables

```bash
cp .env.example .env
```

Buka `.env` dan isi:

```env
SECRET_KEY=isi_dengan_string_acak_panjang
ADMIN_USERNAME=username_pilihanmu
ADMIN_PASSWORD=password_kuat_pilihanmu
```

> Generate SECRET_KEY yang aman:
> ```bash
> python -c "import secrets; print(secrets.token_hex(32))"
> ```

### 5. Jalankan

```bash
python app.py
```

Akses di `http://127.0.0.1:5000` — database akan dibuat otomatis saat pertama run.

---

## 🌐 Deploy ke Server Produksi (Gunicorn + Nginx + Systemd)

Panduan ini untuk server Ubuntu/Debian dengan domain yang sudah mengarah ke IP server.

### Prasyarat Server
- Ubuntu 20.04+ / Debian
- Nginx terinstall (`sudo apt install nginx`)
- Python 3.8+
- Domain yang sudah pointing ke IP server

---

### Step 1 — Upload & Setup di Server

```bash
# Clone repo ke server
git clone https://github.com/Faridrhmn/fg-fess.git /var/www/fg-fess
cd /var/www/fg-fess

# Buat virtual environment
python3 -m venv venv
source venv/bin/activate

# Install semua dependencies (termasuk gunicorn)
pip install -r requirements.txt
```

### Step 2 — Konfigurasi Environment

```bash
cp .env.example .env
nano .env
```

Isi dengan nilai yang aman:

```env
SECRET_KEY=ganti_dengan_hasil_python_secrets_token_hex_32
ADMIN_USERNAME=admin_kamu
ADMIN_PASSWORD=password_sangat_kuat
```

### Step 3 — Uji Gunicorn

Sebelum setup service, pastikan Gunicorn bisa jalan:

```bash
source venv/bin/activate
gunicorn -w 4 --threads 2 --preload -b 0.0.0.0:5000 app:app
```

Akses `http://IP_SERVER:5000` — kalau muncul halaman, lanjut ke step berikutnya. Hentikan dengan `Ctrl+C`.

### Step 4 — Buat Systemd Service

```bash
sudo nano /etc/systemd/system/fgfess.service
```

Isi dengan (sesuaikan path):

```ini
[Unit]
Description=fg/fess Menfess App
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/fg-fess
Environment="PATH=/var/www/fg-fess/venv/bin"
ExecStart=/var/www/fg-fess/venv/bin/gunicorn \
    -w 4 \
    --threads 2 \
    --preload \
    --bind 0.0.0.0:5000 \
    app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktifkan service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable fgfess
sudo systemctl start fgfess

# Cek status
sudo systemctl status fgfess
```

### Step 5 — Konfigurasi Nginx

```bash
sudo nano /etc/nginx/sites-available/fgfess
```

Isi:

```nginx
server {
    listen 80;
    server_name domainmu.com www.domainmu.com;

    # Static files dilayani langsung oleh Nginx (lebih cepat, hemat resource)
    location /static/ {
        alias /var/www/fg-fess/static/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Semua request lain diteruskan ke Gunicorn
    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
    }
}
```

Aktifkan konfigurasi:

```bash
sudo ln -s /etc/nginx/sites-available/fgfess /etc/nginx/sites-enabled/
sudo nginx -t          # test konfigurasi, pastikan "syntax is ok"
sudo systemctl reload nginx
```

### Step 6 — HTTPS dengan SSL (Opsional tapi Disarankan)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d domainmu.com -d www.domainmu.com
```

Certbot akan otomatis update konfigurasi Nginx dan setup auto-renewal.

---

### Perintah Berguna Setelah Deploy

```bash
# Cek log aplikasi secara live
sudo journalctl -u fgfess -f

# Restart app (setelah update kode)
sudo systemctl restart fgfess

# Update kode dari git
cd /var/www/fg-fess
git pull
source venv/bin/activate
pip install -r requirements.txt   # jika ada dependency baru
sudo systemctl restart fgfess
```

---

## 🔐 Akses Admin

- URL: `https://domainmu.com/login`
- Login menggunakan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` dari file `.env`
- Session admin tersimpan di cookie browser — setiap perangkat harus login sendiri
- Admin bisa: **menyembunyikan** pesan (tidak tampil publik) atau **menghapus permanen**

---

## 💾 Backup

File backup otomatis disimpan di folder `backups/` setiap 30 hari dalam format:

```
backups/
└── backup_2026-06-21_00-00-00.txt
```

Untuk backup manual kapanpun bisa dengan menjalankan fungsi `backup_messages()` via Python shell.

---

## 📝 Lisensi

MIT License — bebas digunakan dan dimodifikasi.
