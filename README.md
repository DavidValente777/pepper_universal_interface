# Pepper Universal Interface

A browser-based controller for SoftBank Pepper robots. A local Python server bridges the web UI to the robot over your local network.

---

## Requirements

- Python 3 (any recent version to run the setup script itself)
- The `qi` library (NAOqi SDK) — published on PyPI as `qi==3.1.5`, but only as **prebuilt wheels for specific platforms**:

  | Platform | Supported? | Notes |
  |----------|------------|-------|
  | Linux (x86_64) | ✅ | Python 3.7 – 3.12 |
  | macOS (Apple Silicon) | ✅ | Python 3.12 only |
  | macOS (Intel) | ❌ | No wheel published for this qi version |
  | Windows | ❌ | No wheel published since qi 2.0.1 — use WSL2 (Ubuntu) instead |

  On Linux, plain `pip` already resolves a `qi` wheel for whatever Python 3.7–3.12 you already have. On Apple Silicon macOS the wheel is 3.12-only, which is why `uv` (see below) is worth using there — it fetches that exact version automatically. Windows and Intel Mac have no `qi` wheel at all, regardless of tooling.

- Your computer and the Pepper robot on the **same network**

---

## How to Run

Both platforms below use the same command — `python3 run.py` — which creates (or reuses) a `.venv`, installs `requirements.txt`, and starts the server. It's safe to re-run.

### macOS (Apple Silicon)

The `qi` wheel only targets Python 3.12 here, so install [uv](https://docs.astral.sh/uv/) first (`brew install uv`) — `run.py` detects it automatically and delegates to `uv run bridge.py`, which fetches Python 3.12 and `qi` for you with no manual venv/version juggling:

```bash
python3 run.py
python3 run.py --http-port 9000   # custom port
```

(Equivalent to running `uv run bridge.py` directly, if you prefer.)

### Linux (x86_64)

`qi` publishes wheels for Python 3.7–3.12 on Linux, so your system Python almost certainly already works — no extra tools needed, just `run.py` and your existing `python3`/`pip`:

```bash
python3 run.py
python3 run.py --http-port 9000   # custom port
```

(`uv` is optional here — `run.py` will use it if it's on your PATH, but plain `venv`/`pip` works fine too.)

### Windows

No `qi` wheel is published for Windows past qi 2.0.1. Run `bridge.py` from WSL2 (Ubuntu) instead and follow the Linux instructions above from there — `controller.html` itself still works fine directly in a Windows browser; only the Python bridge needs Linux/macOS.

---

Then open your browser at `http://localhost:8000/controller.html`.

### Manual setup (if you'd rather not use `run.py`)

```bash
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python bridge.py
```

---

## Connecting to a Robot

1. Enter your computer's IP address in the **Your computer's IP address** field (run `hostname -I` on Linux/Mac or `ipconfig` on Windows to find it)
2. Enter the robot's IP address in the **Pepper robot IP address** field
3. Click **Connect**

On a successful connection the server automatically:
- Disables Autonomous Life (prevents the robot moving or sleeping on its own)
- Stops any running behaviours and animations
- Disables background idle movements and head tracking
- Wakes up the robot motors

The connection is polled every 5 seconds. If it drops, the server will attempt to auto-reconnect using the last known IPs.

---

## Features

| Feature | Description |
|---------|-------------|
| **Speech** | Type text for Pepper to say immediately |
| **Text Display** | Show text on Pepper's tablet with adjustable font size and colour |
| **Image Display** | Drag & drop or select a JPG/PNG to display on the tablet |
| **Motions** | Choose and play one of Pepper's built-in animations |
| **Sequence Builder** | Build a timeline of speech, text, image, motion, and delay steps; reorder by drag & drop; export/import as JSON |
| **Error Log** | All runtime errors are logged in-page with a count indicator in the header bar |

---

## Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Returns connection status and current IPs |
| GET | `/send?text=...&fontSize=...&color=...` | Display text on the tablet |
| POST | `/connect` | Connect to a robot (`hostIp`, `pepperIp`) |
| POST | `/disconnect` | Disconnect from the robot |
| POST | `/speak` | Make Pepper say text (`text`) |
| POST | `/send-image` | Display an image on the tablet (`imageData` as data URI) |
| POST | `/motion` | Play a named animation (`motion`) |
| POST | `/stop-motion` | Stop all animations |
| POST | `/wake-up` | Wake up robot motors |
| POST | `/emergency-stop` | Stop animations and put robot in rest position |
| POST | `/list-behaviors` | List installed and running behaviours |
| POST | `/stop-behavior` | Stop all running behaviours |

Text and images are sent to the tablet as self-contained `data:text/html` URIs, so the tablet does not need to make any HTTP request back to this server.

---

## File Structure

```
pepper_universal_interface/
├── controller.html          # Web UI markup
├── controller.css           # Web UI styles
├── controller.js            # Web UI logic
├── bridge.py                # Python HTTP server — qi bridge to the robot
├── run.py                   # One-command setup + launch (venv, deps, qi)
├── requirements.txt         # Python dependencies (pip install -r requirements.txt)
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Not connected to Pepper" | Check both devices are on the same network, the IPs are correct, and NAOqi is running on the robot |
| Connection drops repeatedly | Click **Disconnect** then **Connect** again; check network stability |
| Robot won't move | Click **Wake Up** to re-enable motor stiffness |
| Animations don't play | Ensure the robot is awake (Wake Up) and no emergency stop is active |
| `run.py` exits with "could not import 'qi'" | Your platform/Python combo has no prebuilt wheel — check the table in [Requirements](#requirements). On Windows or Intel Mac, run `bridge.py` from WSL2/Linux instead. On Apple Silicon, install Python 3.12, delete `.venv/`, and re-run `run.py` |
