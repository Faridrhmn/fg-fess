# ✉️ Send Me a Message!

![UI Preview](static/logo.png) <!-- Update with your actual preview image path later -->

Sometimes, people have stories, critiques, or feelings that are difficult to express face-to-face. **Send Me a Message!** is a secure, private, and anonymous web dashboard built to bridge that gap. It serves as a safe digital space where anyone can drop their honest thoughts directly to the creator without any hesitation. 

Constructive criticism, random rants, or untold stories—everything is welcome, and there are absolutely no hard feelings.

---

## ✨ Features

- **🔒 Secure & Anonymous**: A safe space for users to drop messages anonymously.
- **🛡️ Admin Dashboard**: A secure login portal for the creator to read, manage, and delete incoming messages safely.
- **🎨 Modern Dark Glassmorphism UI**: Beautiful, highly responsive, and interactive interface built with vanilla CSS.
- **🗄️ Automated Backups**: A background scheduler automatically backs up all messages to a text file every 30 days to ensure no data is lost.
- **⚙️ Environment Secured**: Administrative credentials and secret keys are securely loaded from a `.env` file to prevent accidental exposure.

## 🛠️ Technology Stack

- **Backend**: Python 3, Flask, Flask-SQLAlchemy, Flask-Login
- **Frontend**: HTML5, Vanilla CSS (Glassmorphism), JavaScript (Fetch API)
- **Database**: SQLite3
- **Automation**: `APScheduler`
- **Environment**: `python-dotenv`

## 🚀 Getting Started

### Prerequisites

Ensure you have Python 3.8+ installed on your system.

### 1. Clone the repository

```bash
git clone https://github.com/Faridrhmn/send-me-a-message.git
cd send-me-a-message
```

### 2. Create a Virtual Environment (Optional but recommended)

```bash
python -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Setup Environment Variables

Copy the example environment file and create your own `.env` file:

```bash
cp .env.example .env
```
Open `.env` and fill in your desired `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a secure `SECRET_KEY`.

### 5. Run the Application

```bash
python app.py
```
The database (`messages.db`) will be automatically initialized and empty upon the first run. The app will be accessible at `http://127.0.0.1:5000`.

## 📂 Project Structure

```text
send-me-a-message/
├── app.py                  # Main Flask application
├── requirements.txt        # Python dependencies
├── .env.example            # Environment variables template
├── instance/               # Auto-generated folder containing the SQLite DB
├── static/                 # Static assets (CSS, JS, Images)
│   ├── style.css
│   ├── script.js
│   └── logo.png
└── templates/              # HTML Templates
    ├── index.html          # Public messaging page
    ├── login.html          # Admin login page
    └── admin.html          # Secure admin inbox dashboard
```

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Faridrhmn/send-me-a-message/issues).

## 📝 License

This project is licensed under the MIT License.
