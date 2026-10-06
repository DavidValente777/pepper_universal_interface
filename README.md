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
| **Battery** | Battery level and charging state in the top bar, refreshed with the connection poll |
| **Clear Tablet** | One big button that removes whatever is on the tablet (text, image, video, webpage) |
| **Volume / Pitch / Brightness** | Sliders for speaker volume, voice pitch (50–200%) and tablet brightness; they show the robot's current values on connect |
| **Drive** | Toggle keyboard driving on, then hold ↑/↓ to drive, ←/→ to turn, Shift+←/→ to slide sideways (or hold the on-screen arrows). Release or press Space to stop. Speed is adjustable and capped at 0.35 m/s |
| **Obstacle avoidance** | Toggle Pepper's built-in obstacle avoidance while driving (asks for confirmation; switches back on automatically when driving is switched off). The robot must allow deactivation of safety reflexes, otherwise it refuses and the page explains why |
| **Automatic reconnect** | If the connection to Pepper drops, the bridge reconnects on its own (retrying with backoff, even with no browser open). If the bridge itself restarts, the page reconnects it. Reconnects never wake the robot or stop what it is doing |
| **Speech** | Type text for Pepper to say immediately |
| **Text Display** | Show text on Pepper's tablet with adjustable font size and colour |
| **Image Display** | Drag & drop or select a JPG/PNG; it is shown as large as possible on the tablet (1280×800) without distorting its aspect ratio |
| **Motions** | Play any animation installed on the robot — the list is loaded from the robot on connect (standard animations plus animations shipped with installed apps; system apps such as shutdown/reboot are excluded). A search box filters the motion pickers |
| **Camera** | Live feed from the head (forehead) or mouth camera, or the eyes 3D sensor as infrared, depth, or infrared coloured by distance. Robots without a given camera get a clear error, and the feed is released when switched off |
| **Sequence Builder** | Build a sequence of steps from speech, text, image, motion and delay blocks. Stack blocks in one step to run them at the same time (one per kind: speech, motion, tablet text/image, wait); the next step starts when all of them have finished. Drag a block onto a step to join it or into the gap between steps to make a new step. Arrows show the order. Export/import as JSON (older single-row exports still import). During playback the current step is highlighted, finished/failed/stopped blocks are marked, and errors are shown on the failing block |
| **Error Log** | All runtime errors are logged in-page with a count indicator in the header bar |

---

## Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Connection status, current IPs, `reconnecting`/`attempts`/`lastError` while reconnecting, and whether the robot is `awake`, plus `battery` (0–100) and `charging` |
| GET | `/send?text=...&fontSize=...&color=...` | Display text on the tablet |
| POST | `/connect` | Connect to a robot (`hostIp`, `pepperIp`; `reconnect: true` skips waking the robot) |
| POST | `/disconnect` | Disconnect from the robot |
| POST | `/speak` | Make Pepper say text (`text`) |
| POST | `/send-image` | Display an image on the tablet (`imageData` as data URI) |
| GET | `/camera?cam=0..4` | One camera frame as PNG (0 head, 1 mouth, 2 eyes infrared, 3 eyes depth, 4 infrared + distance colour) |
| POST | `/camera-stop` | Release the camera subscriptions |
| GET | `/settings` | Current `volume`, `brightness` (0–100) and voice `pitch` |
| POST | `/set-volume` / `/set-brightness` / `/set-pitch` | Set a value (`value`: 0–100, 0–100, 50–200) |
| POST | `/clear-tablet` | Hide the webview, image and video on the tablet |
| POST | `/list-motions` | Animations (`animations`) and app animations (`behaviors`) installed on the robot |
| POST | `/motion` | Play a named animation or app animation (`motion`) |
| POST | `/stop-motion` | Stop all animations |
| POST | `/stop-speech` | Interrupt current speech |
| POST | `/drive` | Drive the wheels (`x` forward, `y` left, `theta` turn left — each −1…1 — and `speed` 0.1…1). Must be re-sent at least every 0.6 s or the wheels stop |
| POST | `/drive-stop` | Stop the wheels |
| POST | `/set-obstacle-avoidance` | Turn obstacle avoidance on/off (`enabled`: true/false) |
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
├── sequence.js              # Sequence step model (shared by the page and the tests)
├── bridge.py                # Python HTTP server — qi bridge to the robot
├── run.py                   # One-command setup + launch (venv, deps, qi)
├── requirements.txt         # Python dependencies (pip install -r requirements.txt)
├── tests/
│   ├── sequence.test.js     # Unit tests for sequence.js
│   └── browser/             # Headless Chrome tests for the Sequence Builder
├── docs/                    # Design notes and implementation plans
└── README.md
```

---

## Running the Tests

The tests use Node's built-in test runner (Node 18+); no `npm install` is needed.

```bash
node --test tests/sequence.test.js            # step model unit tests
node --test tests/browser/*.test.mjs          # Sequence Builder in headless Chrome
```

The browser tests need Google Chrome. Set `CHROME=/path/to/chrome` if it isn't on your PATH as `google-chrome`. They use a fake bridge, so no robot is required.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Not connected to Pepper" | Check both devices are on the same network, the IPs are correct, and NAOqi is running on the robot |
| Connection drops repeatedly | Click **Disconnect** then **Connect** again; check network stability |
| Robot won't move | Click **Wake Up** to re-enable motor stiffness |
| Animations don't play | Ensure the robot is awake (Wake Up) and no emergency stop is active |
| `run.py` exits with "could not import 'qi'" | Your platform/Python combo has no prebuilt wheel — check the table in [Requirements](#requirements). On Windows or Intel Mac, run `bridge.py` from WSL2/Linux instead. On Apple Silicon, install Python 3.12, delete `.venv/`, and re-run `run.py` |

### Pepper won't drive

- **"Charging flap is open"** — close the charging flap at the back of Pepper's base. NAOqi locks the wheels while it is open.
- **"Obstacle too close in that direction"** — Pepper's built-in collision protection refused the move; try another direction or clear the area.
- **"Pepper is resting"** — press **Wake Up** first. If Pepper keeps going back to rest on its own, its self-diagnosis has found a hardware problem (check the robot log for "Robot health is bad").
- Driving always stops when you release the keys, press Space, switch driving off, press Stop Motion / Emergency Stop, switch to another window, or if the browser stops sending commands for 0.6 s.
