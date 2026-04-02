# Pepper Universal Interface

A browser-based controller for SoftBank Pepper robots. Runs a local Python HTTP server that bridges the web UI to the robot over your local network.

---

## Requirements

- Your computer and the Pepper robot must be on the **same network**
- **Python 3** with the `qi` library (NAOqi SDK): `pip install qi==3.1.5`

---

## How to Run

```bash
python pepper_text_server.py
```

Then open your browser at:

```
http://localhost:8000/controller.html
```

You can optionally specify a different port:

```bash
python pepper_text_server.py --http-port 9000
```

---

## Connecting to a Robot

1. Select your IP from the **Your Computer IP** dropdown, or choose "Other..." and enter it manually (run `hostname -I` in a terminal to find your IP)
2. Select the robot from the **Pepper Robot** dropdown, or choose "Add new..." and enter the robot's IP
3. Click **Connect**

On a successful connection the server automatically:
- Disables Autonomous Life (prevents the robot falling asleep or moving on its own)
- Stops any running behaviors or animations
- Disables background idle movements and head tracking
- Wakes up the robot motors

The connection is monitored every 5 seconds. If it drops, the server will attempt to auto-reconnect using the last known IPs.

---

## Features

| Feature | Description |
|---------|-------------|
| **Connection Panel** | Connect / disconnect from any Pepper robot by IP |
| **Robot Control** | Wake Up, Stop Motion, Emergency Stop |
| **Speech** | Type text for Pepper to say immediately |
| **Text Display** | Show text on Pepper's tablet with adjustable font size and colour |
| **Image Display** | Drag & drop a JPG/PNG to display on the tablet |
| **Motions** | Browse and play Pepper's built-in animations; mark favourites |
| **Sequence Builder** | Build a timeline of speech / text / image / motion / delay steps; reorder by drag & drop; export/import as JSON |

---

## Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Connection status (verifies qi session is alive) |
| GET | `/send?text=...&fontSize=...&color=...` | Display text on Pepper's tablet |
| POST | `/connect` | Connect to a robot (`hostIp`, `pepperIp`) |
| POST | `/disconnect` | Disconnect from the robot |
| POST | `/speak` | Make Pepper say text |
| POST | `/send-image` | Display a base64 image on the tablet |
| POST | `/motion` | Play a named animation |
| POST | `/stop-motion` | Stop all animations |
| POST | `/wake-up` | Wake up robot motors |
| POST | `/emergency-stop` | Stop animations and put robot in rest position |
| POST | `/list-behaviors` | List installed and running behaviors |
| POST | `/stop-behavior` | Stop all running behaviors |

---

## File Structure

```
pepper_universal_interface/
├── controller.html          # Main web UI
├── pepper_text_server.py    # Python HTTP server (qi bridge to robot)
├── display.html             # Tablet text display page (served to robot)
├── image_display.html       # Tablet image display page (served to robot)
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Not connected to Pepper" | Check you're on the same network, IPs are correct, and naoqi is running on the robot |
| "Socket is not connected" | The session dropped — the server will auto-reconnect. If it persists, click Disconnect then Connect again |
| Robot won't move | Click **Wake Up** |
| Need to find your IP | Run `hostname -I` (Linux/Mac) or `ipconfig` (Windows) in a terminal |
