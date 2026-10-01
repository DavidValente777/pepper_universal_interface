# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#     "qi==3.1.5",
# ]
# ///
import argparse
import threading
import time
import qi
import json
import re
import array
import base64
import colorsys
import struct
import zlib
import html as html_module
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# Dynamic Pepper connection details (set via /connect endpoint)
PEPPER_IP = None
PEPPER_PORT = 9559
HOST_IP = None
HTTP_PORT = 8000

tablet = None
tts = None
animation_player = None
motion = None
behavior_manager = None
audio_device = None
memory = None
battery = None
video_device = None
app = None
is_connected = False
reconnect_lock = threading.Lock()  # prevents concurrent (re)connect attempts

# Automatic reconnection. After a successful /connect the bridge keeps the
# robot connected on its own: a background monitor checks the session every
# couple of seconds and reconnects with backoff when it drops, whether or not
# a browser is open. /disconnect switches this off.
CONNECT_TIMEOUT_MS = 8000
LIVENESS_TIMEOUT_MS = 3000
LIVENESS_INTERVAL = 2.0
RECONNECT_MAX_DELAY = 15.0
want_connected = False
reconnect_attempts = 0
last_connection_error = None

# Voice pitch in percent (50-200, 100 = normal). Applied to every /speak via
# the \vct=N\ TTS tag, since ALTextToSpeech's pitchShift parameter can only
# raise the pitch, never lower it.
voice_pitch = 100

BATTERY_CURRENT_KEY = "Device/SubDeviceList/Battery/Current/Sensor/Value"

# Behaviors started via /motion, so /stop-motion can stop them
launched_behaviors = set()

# Pepper's tablet is 1280x800. The image fills the viewport as a
# "contain"-sized background: as large as possible, never distorted, and it
# also scales small images *up* (a plain <img max-width> only scales down).
IMAGE_PAGE_TEMPLATE = (
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
    '<style>html,body{{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}}'
    '#img{{position:fixed;top:0;left:0;right:0;bottom:0;'
    'background:url("{src}") center center/contain no-repeat}}</style></head>'
    '<body><div id="img"></div></body></html>'
)


# Keyboard driving. The browser sends /drive repeatedly while a key is held;
# if commands stop arriving (tab closed, Wi-Fi drop, lost key-up event) the
# watchdog stops the wheels. Speeds are capped well below Pepper's 0.55 m/s.
DRIVE_MAX_LINEAR = 0.35   # m/s at 100% speed
DRIVE_MAX_ANGULAR = 1.0   # rad/s at 100% speed
DRIVE_TIMEOUT = 0.6       # seconds without a /drive command before stopping
drive_lock = threading.Lock()
drive_active = False
drive_last_command = 0.0
drive_started = 0.0

# Camera feed. The browser fetches /camera frame by frame; the bridge keeps
# the feed's ALVideoDevice subscriptions open while frames are being asked
# for and releases them after CAMERA_IDLE_TIMEOUT seconds without a request.
CAMERA_RESOLUTION = 1      # kQVGA, 320x240 (higher costs a lot of Wi-Fi bandwidth)
CAMERA_FPS = 15
CAMERA_IDLE_TIMEOUT = 5.0
CAMERA_SUBSCRIBER = "pepper_controller"
RGB_SPACE = 11             # kRGBColorSpace
DEPTH_SPACE = 17           # kDepthColorSpace, millimetres
INFRARED_SPACE = 20        # 10-bit infrared intensity
# Feed id (the ?cam= value) -> (label, [(NAOqi camera index, colour space), ...]).
# The eyes' 3D sensor (index 2) gives 16-bit infrared and depth images whose
# pixels line up, so the colour feed combines the two.
CAMERAS = {
    0: ("top (forehead)", [(0, RGB_SPACE)]),
    1: ("bottom (mouth)", [(1, RGB_SPACE)]),
    2: ("eyes infrared", [(2, INFRARED_SPACE)]),
    3: ("eyes depth", [(2, DEPTH_SPACE)]),
    4: ("eyes infrared + distance colour", [(2, INFRARED_SPACE), (2, DEPTH_SPACE)]),
}
NAOQI_CAMERA_NAMES = {0: "top (forehead)", 1: "bottom (mouth)", 2: "eyes 3D sensor"}
# Depth shown as greyscale (near bright, far dark) or as colour (near red,
# far blue); unknown depth (0) is black, or plain infrared in the colour feed
DEPTH_NEAR_MM = 300
DEPTH_FAR_MM = 4500
camera_lock = threading.Lock()
camera_handles = []        # subscriptions of the open feed, in CAMERAS order
camera_index = None        # feed id they belong to
camera_last_used = 0.0


def clamp(value, low, high):
    return max(low, min(high, value))

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        SimpleHTTPRequestHandler.end_headers(self)

    def send_json(self, code, obj):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode("utf-8"))

    def read_json(self):
        content_length = int(self.headers.get('Content-Length') or 0)
        if content_length == 0:
            return {}
        return json.loads(self.rfile.read(content_length).decode('utf-8'))

    def require_connection_json(self):
        """Send a 503 JSON error and return False if Pepper isn't reachable."""
        if not is_connected or not ensure_connected():
            self.send_json(503, {"success": False, "error": "Not connected to Pepper"})
            return False
        return True

    def do_GET(self):
        global tablet, is_connected, HOST_IP, PEPPER_IP

        parsed = urlparse(self.path)

        # Return connection status (actually verifies the qi session is alive)
        if parsed.path == "/status":
            awake = None
            battery_level = None
            charging = None
            if is_connected and ensure_connected():
                try:
                    awake = bool(motion.robotIsWakeUp(_async=True).value(1000))
                except Exception:
                    pass
                try:
                    battery_level = int(battery.getBatteryCharge(_async=True).value(1000))
                    # Current is positive while charging, negative while discharging
                    charging = float(memory.getData(BATTERY_CURRENT_KEY, _async=True).value(1000)) > 0
                except Exception:
                    pass

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            status = {
                "connected": is_connected,
                "reconnecting": want_connected and not is_connected,
                "attempts": reconnect_attempts,
                "awake": awake,
                "battery": battery_level,
                "charging": charging,
                "lastError": last_connection_error,
                "hostIp": HOST_IP,
                "pepperIp": PEPPER_IP
            }
            self.wfile.write(json.dumps(status).encode("utf-8"))
            return

        # Called by controller.html -> /send?text=...&fontSize=...&color=...
        if parsed.path == "/send":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Error: Not connected to Pepper")
                return
            qs = parse_qs(parsed.query)

            # Allow empty string (used by Clear button)
            text = (qs.get("text", [""])[0]).strip()
            fontSize = qs.get("fontSize", ["110"])[0]
            color = qs.get("color", ["#000000"])[0]

            # Build minimal HTML and send as a data URI so Pepper's tablet
            # does not need to make an HTTP request back to this server.
            safe_text = html_module.escape(text)
            inline_html = (
                '<html><body style="margin:0;height:100vh;background:#fff;font-family:sans-serif;'
                'display:flex;align-items:center;justify-content:center;text-align:center;'
                'padding:30px;box-sizing:border-box;">'
                f'<div style="font-size:{fontSize}px;color:{color};line-height:1.1;'
                f'word-break:break-word">{safe_text}</div></body></html>'
            )
            data_url = "data:text/html;base64," + base64.b64encode(inline_html.encode("utf-8")).decode("ascii")

            try:
                tablet.showWebview(data_url)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK: Text sent to Pepper tablet")
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f"Error: {str(e)}".encode("utf-8"))
            return

        # Current volume / tablet brightness / voice pitch, for the sliders
        if parsed.path == "/settings":
            if not self.require_connection_json():
                return
            settings = {"success": True, "pitch": voice_pitch, "volume": None, "brightness": None,
                        "obstacleAvoidance": None}
            try:
                settings["obstacleAvoidance"] = bool(motion.getExternalCollisionProtectionEnabled("Move"))
            except Exception as e:
                print(f"Warning: Could not read obstacle avoidance: {e}")
            try:
                settings["volume"] = int(audio_device.getOutputVolume())
            except Exception as e:
                print(f"Warning: Could not read volume: {e}")
            try:
                settings["brightness"] = int(round(float(tablet.getBrightness()) * 100))
            except Exception as e:
                print(f"Warning: Could not read tablet brightness: {e}")
            self.send_json(200, settings)
            return

        # One camera frame as PNG: /camera?cam=<feed id from CAMERAS>
        if parsed.path == "/camera":
            if not self.require_connection_json():
                return
            try:
                cam = int(parse_qs(parsed.query).get("cam", ["0"])[0])
            except ValueError:
                cam = -1
            if cam not in CAMERAS:
                self.send_json(400, {"success": False, "error": "cam must be one of " + ", ".join(map(str, CAMERAS))})
                return
            try:
                png = camera_frame_png(cam)
            except Exception as e:
                self.send_json(500, {"success": False, "error": f"Camera: {e}"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return

        # Default: serve files normally
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        global tablet, tts, is_connected, PEPPER_IP, HOST_IP, app, motion, voice_pitch
        global want_connected, reconnect_attempts, last_connection_error

        # Handle connection request
        if self.path == "/connect":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            host_ip = data.get('hostIp', '')
            pepper_ip = data.get('pepperIp', '')

            if not host_ip or not pepper_ip:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Missing IP addresses"}).encode("utf-8"))
                return

            try:
                with reconnect_lock:
                    # Update global variables
                    PEPPER_IP = pepper_ip
                    HOST_IP = host_ip
                    want_connected = True
                    reconnect_attempts = 0
                    last_connection_error = None

                    # Connect to Pepper. "reconnect" is sent by the page when it
                    # restores a connection after a bridge restart: the robot is
                    # then left as it is (not woken up, behaviors not stopped).
                    connect_pepper(reconnecting=bool(data.get('reconnect')))

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            except Exception as e:
                # A failed manual connect (wrong IP, robot off) is reported
                # rather than retried forever in the background
                want_connected = False
                is_connected = False
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        # Handle disconnect request
        if self.path == "/disconnect":
            want_connected = False
            stop_driving()
            release_camera()
            try:
                if is_connected:
                    set_obstacle_avoidance(True)  # leave the robot in its safe default
            except Exception:
                pass
            with reconnect_lock:
                is_connected = False
                close_session()
            tablet = None
            tts = None
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            return

        if self.path == "/speak":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Error: Not connected to Pepper")
                return
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            text = data.get('text', '')

            if text:
                try:
                    tts.say(f"\\vct={voice_pitch}\\ {text}")
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(f"OK: Speaking '{text}'".encode("utf-8"))
                except Exception as e:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(f"Error: {str(e)}".encode("utf-8"))
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Error: No text provided")
            return

        if self.path == "/send-image":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Error: Not connected to Pepper")
                return

            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            image_data_uri = data.get('imageData', '')

            if not image_data_uri.startswith("data:image/"):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Error: imageData must be a data:image/... URI")
                return

            # Build minimal HTML with the image as a data URI so Pepper's
            # tablet does not need to fetch anything from this server.
            inline_html = IMAGE_PAGE_TEMPLATE.format(src=image_data_uri.replace('"', '%22'))
            data_url = "data:text/html;base64," + base64.b64encode(inline_html.encode("utf-8")).decode("ascii")

            try:
                tablet.showWebview(data_url)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK: Image sent to Pepper")
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f"Error: {str(e)}".encode("utf-8"))
            return

        if self.path == "/motion":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Error: Not connected to Pepper")
                return

            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            motion_name = data.get('motion', '')

            if motion_name:
                try:
                    run_motion(motion_name)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(f"OK: Playing motion '{motion_name}'".encode("utf-8"))
                except Exception as e:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(f"Error: {str(e)}".encode("utf-8"))
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Error: No motion provided")
            return

        if self.path == "/stop-motion":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"Error: Not connected to Pepper")
                return

            try:
                stop_all_motions()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK: Stopped all motions")
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f"Error: {str(e)}".encode("utf-8"))
            return

        if self.path == "/wake-up":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Not connected to Pepper"}).encode("utf-8"))
                return

            try:
                motion.wakeUp()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
                print("Robot woken up")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        if self.path == "/emergency-stop":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Not connected to Pepper"}).encode("utf-8"))
                return

            try:
                # Stop all animations first
                try:
                    stop_all_motions()
                except Exception:
                    pass

                # Put robot in rest position (safe, motors disabled)
                motion.rest()

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
                print("Emergency stop executed - robot in rest position")
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        # Keyboard driving: x = forward(+)/back(-), y = left(+)/right(-),
        # theta = turn left(+)/right(-), each -1..1; speed = 0.1..1
        if self.path == "/drive":
            if not self.require_connection_json():
                return
            try:
                data = self.read_json()
                x = clamp(float(data.get("x", 0)), -1.0, 1.0)
                y = clamp(float(data.get("y", 0)), -1.0, 1.0)
                theta = clamp(float(data.get("theta", 0)), -1.0, 1.0)
                speed = clamp(float(data.get("speed", 0.5)), 0.1, 1.0)
            except (TypeError, ValueError):
                self.send_json(400, {"success": False, "error": "x, y, theta and speed must be numbers"})
                return
            try:
                if x == 0 and y == 0 and theta == 0:
                    stop_driving()
                else:
                    drive(x * speed * DRIVE_MAX_LINEAR,
                          y * speed * DRIVE_MAX_LINEAR,
                          theta * speed * DRIVE_MAX_ANGULAR)
                self.send_json(200, {"success": True})
            except Exception as e:
                stop_driving()
                self.send_json(500, {"success": False, "error": str(e)})
            return

        # Pepper's built-in obstacle avoidance while driving ("Move" external
        # collision protection). NAOqi refuses to switch it off unless
        # deactivating safety reflexes has been allowed on the robot.
        if self.path == "/set-obstacle-avoidance":
            if not self.require_connection_json():
                return
            enabled = self.read_json().get("enabled")
            if not isinstance(enabled, bool):
                self.send_json(400, {"success": False, "error": "enabled must be true or false"})
                return
            try:
                set_obstacle_avoidance(enabled)
                self.send_json(200, {"success": True, "enabled": enabled})
            except Exception as e:
                message = str(e)
                if "without first enabling" in message:
                    message = ("Pepper refused: switching off obstacle avoidance is not allowed on this robot. "
                               "Tick \"Permit deactivation of the safety reflexes\" at "
                               f"http://{PEPPER_IP}/apps/robots_advanced/#/settings first.")
                self.send_json(409, {"success": False, "error": message})
            return

        if self.path == "/drive-stop":
            if not self.require_connection_json():
                return
            try:
                stop_driving(raise_errors=True)
                self.send_json(200, {"success": True})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        if self.path == "/camera-stop":
            release_camera()
            self.send_json(200, {"success": True})
            return

        if self.path == "/stop-speech":
            if not self.require_connection_json():
                return
            try:
                tts.stopAll()
                self.send_json(200, {"success": True})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        # Remove whatever is on the tablet (webview, image, video)
        if self.path == "/clear-tablet":
            if not self.require_connection_json():
                return
            errors = []
            for name, action in (
                ("hideWebview", lambda: tablet.hideWebview()),
                ("hideImage", lambda: tablet.hideImage()),
                ("stopVideo", lambda: tablet.stopVideo()),
            ):
                try:
                    action()
                except Exception as e:
                    errors.append(f"{name}: {e}")
            if len(errors) == 3:
                self.send_json(500, {"success": False, "error": "; ".join(errors)})
            else:
                self.send_json(200, {"success": True})
            return

        if self.path in ("/set-volume", "/set-brightness", "/set-pitch"):
            if not self.require_connection_json():
                return
            try:
                value = int(self.read_json().get("value"))
            except (TypeError, ValueError):
                self.send_json(400, {"success": False, "error": "value must be a number"})
                return
            try:
                if self.path == "/set-volume":
                    value = clamp(value, 0, 100)
                    audio_device.setOutputVolume(value)
                elif self.path == "/set-brightness":
                    value = clamp(value, 0, 100)
                    tablet.setBrightness(value / 100.0)
                else:
                    value = clamp(value, 50, 200)
                    voice_pitch = value
                self.send_json(200, {"success": True, "value": value})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        # Animations and behaviors installed on the robot, for the Motions lists
        if self.path == "/list-motions":
            if not self.require_connection_json():
                return
            try:
                installed = sorted(set(behavior_manager.getInstalledBehaviors()))
                animations = [b for b in installed if is_pepper_animation(b)]
                behaviors = [b for b in installed if is_animation_like_behavior(b)]
                self.send_json(200, {"success": True, "animations": animations, "behaviors": behaviors})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        # List installed behaviors on Pepper
        if self.path == "/list-behaviors":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Not connected to Pepper"}).encode("utf-8"))
                return

            try:
                installed = behavior_manager.getInstalledBehaviors()
                running = behavior_manager.getRunningBehaviors()

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "success": True,
                    "installed": installed,
                    "running": running
                }).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        # Stop current behavior
        if self.path == "/stop-behavior":
            if not is_connected or not ensure_connected():
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Not connected to Pepper"}).encode("utf-8"))
                return

            try:
                behavior_manager.stopAllBehaviors()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()


def is_pepper_animation(path):
    """Animations Pepper can play: animations/Stand/... (Sit ones are NAO-only)."""
    return path.startswith("animations/") and not path.startswith("animations/Sit")


# Robot apps also ship their own animations (e.g. boston_animation_library/...,
# seeandlisten/animations/...). Only those are offered: most other installed
# behaviors are system apps (shutdown, reboot, lie down, boot-config, ...)
# that must not be one click away in a motions list.
ANIMATION_DIR_RE = re.compile(r"(^|/)(anims?|animations?|[a-z_]*animation_library)(/|$)", re.IGNORECASE)
EXCLUDED_BEHAVIOR_PACKAGES = ("boot-config/", "dialog_posture/", "dialog_shutdown/")


def is_animation_like_behavior(path):
    if path.startswith("animations/") or path.startswith(EXCLUDED_BEHAVIOR_PACKAGES):
        return False
    if "/Nao/" in path or "/Sit/" in path or "declare_animationlibrary" in path:
        return False
    return bool(ANIMATION_DIR_RE.search(path))


def run_motion(name):
    """Play an animation, or run any other installed behavior. Blocks until done."""
    if not name.startswith("animations/") and not behavior_manager.isBehaviorInstalled(name):
        raise RuntimeError(f"Behavior '{name}' is not installed on the robot")
    launched_behaviors.add(name)
    try:
        if name.startswith("animations/"):
            animation_player.run(name)
        else:
            behavior_manager.runBehavior(name)
    finally:
        launched_behaviors.discard(name)


def drive_blocked_reason():
    """Why NAOqi refused the last move, in words (it fails silently otherwise)."""
    try:
        failure = memory.getData("ALMotion/MoveFailed")
        cause = failure[0] if failure else ""
    except Exception:
        cause = ""
    if cause == "Safety":
        return "Pepper stopped: obstacle too close in that direction"
    return f"Pepper refused to move ({cause or 'unknown reason'})"


def drive(vx, vy, vtheta):
    """Start/update wheel movement (m/s, m/s, rad/s) and feed the watchdog."""
    global drive_active, drive_last_command, drive_started
    with drive_lock:
        now = time.monotonic()
        if drive_active and now - drive_started > 0.4 and not motion.moveIsActive():
            # Movement was blocked by NAOqi (obstacle, internal safety stop, ...)
            drive_active = False
            motion.stopMove()
            raise RuntimeError(drive_blocked_reason())
        if not drive_active:
            if not motion.robotIsWakeUp():
                raise RuntimeError("Pepper is resting - press Wake Up before driving")
            try:
                trap_open = memory.getData("BatteryTrapIsOpen")
            except Exception:
                trap_open = False
            if trap_open:
                raise RuntimeError("Pepper's charging flap is open - close it to drive (the wheels are locked while it is open)")
            drive_started = now
        motion.move(vx, vy, vtheta)
        drive_active = True
        drive_last_command = now


def stop_driving(raise_errors=False):
    global drive_active
    with drive_lock:
        drive_active = False
        if motion is None:
            return
        try:
            motion.stopMove()
        except Exception as e:
            print(f"Warning: Could not stop driving: {e}")
            if raise_errors:
                raise


def set_obstacle_avoidance(enabled):
    motion.setExternalCollisionProtectionEnabled("Move", enabled)
    if bool(motion.getExternalCollisionProtectionEnabled("Move")) != enabled:
        raise RuntimeError("Pepper did not apply the obstacle avoidance setting")


def drive_watchdog():
    while True:
        time.sleep(0.1)
        if drive_active and time.monotonic() - drive_last_command > DRIVE_TIMEOUT:
            print("Drive watchdog: no command received - stopping wheels")
            stop_driving()


def encode_png(width, height, pixels, channels=3):
    """Minimal RGB (3) or greyscale (1) PNG encoder (keeps the bridge free of image libraries)."""
    stride = width * channels
    raw = b"".join(b"\x00" + pixels[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    color_type = 2 if channels == 3 else 0
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b""))


def unsubscribe_camera():
    """Drop the current subscriptions (caller holds camera_lock)."""
    global camera_handles, camera_index
    if video_device is not None:
        for handle in camera_handles:
            try:
                video_device.unsubscribe(handle)
            except Exception as e:
                print(f"Warning: Could not release camera: {e}")
    camera_handles = []
    camera_index = None


def release_camera():
    with camera_lock:
        unsubscribe_camera()


def release_stale_subscriptions():
    """Unsubscribe "pepper_controller_N" subscriptions this bridge doesn't hold.

    NAOqi keeps a subscription until it is explicitly released, even after the
    client is gone (bridge stopped, session dropped), and allows at most 7 per
    name, so leftovers eventually block every new subscription."""
    stale = [name for name in video_device.getSubscribers()
             if name.startswith(CAMERA_SUBSCRIBER + "_") and name not in camera_handles]
    for name in stale:
        try:
            video_device.unsubscribe(name)
        except Exception as e:
            print(f"Warning: Could not release old camera subscription {name}: {e}")
    if stale:
        print(f"Released {len(stale)} leftover camera subscription(s)")
    return bool(stale)


def subscribe_feed(cam):
    """Open every stream feed `cam` needs (caller holds camera_lock)."""
    global camera_handles, camera_index
    label, streams = CAMERAS[cam]
    for index, color_space in streams:
        subscribe = lambda: video_device.subscribeCamera(
            CAMERA_SUBSCRIBER, index, CAMERA_RESOLUTION, color_space, CAMERA_FPS)
        handle = subscribe()
        # NAOqi 2.5 returns "" instead of raising when it refuses a subscription
        if not handle and release_stale_subscriptions():
            handle = subscribe()
        if not handle:
            unsubscribe_camera()
            indexes = video_device.getCameraIndexes()
            if index in indexes:
                raise RuntimeError(f"Pepper refused to open the {label} camera - try again, or reboot Pepper")
            # e.g. the head's camera board isn't detected
            available = ", ".join(NAOQI_CAMERA_NAMES.get(i, f"#{i}") for i in indexes)
            raise RuntimeError(f"the {label} camera is not available on the robot "
                               f"(NAOqi sees only: {available or 'none'}) - try rebooting Pepper")
        camera_handles.append(handle)
    camera_index = cam


def grab_camera_images(cam):
    """Raw ALVideoDevice images of feed `cam`, one per stream (caller holds camera_lock)."""
    if camera_handles and camera_index != cam:
        unsubscribe_camera()
    resubscribed = False
    for _ in range(10):  # the first frame after subscribing can take a moment
        if not camera_handles:
            subscribe_feed(cam)
        try:
            # Asked for in parallel so a two-stream feed waits for Wi-Fi once
            futures = [video_device.getImageRemote(handle, _async=True) for handle in camera_handles]
            images = [future.value() for future in futures]
        except Exception:
            # Subscription lost (e.g. NAOqi restarted): subscribe again once
            if resubscribed:
                raise
            unsubscribe_camera()
            resubscribed = True
            continue
        if all(images):
            return images
        time.sleep(0.05)
    raise RuntimeError(f"no image from the {CAMERAS[cam][0]} camera")


def image_bytes(image):
    data = image[6]
    if isinstance(data, (list, tuple)):  # some qi versions return a list of ints
        return bytes(data)
    if isinstance(data, str):
        return data.encode("latin-1")
    return bytes(data)


def camera_frame_png(cam):
    global camera_last_used
    with camera_lock:
        camera_last_used = time.monotonic()
        images = grab_camera_images(cam)
    width, height = images[0][0], images[0][1]
    streams = CAMERAS[cam][1]
    if streams[0][1] == RGB_SPACE:
        return encode_png(width, height, image_bytes(images[0]))
    # 16-bit little-endian, same as the robot
    planes = [array.array("H", image_bytes(image)) for image in images]
    if len(planes) == 2:
        return encode_png(width, height, distance_tinted_infrared(planes[0], planes[1]))
    values = planes[0]
    if streams[0][1] == DEPTH_SPACE:
        grey = bytes(map(DEPTH_LUT.__getitem__, values))
    else:
        grey = bytes(map(infrared_lut(values).__getitem__, values))
    return encode_png(width, height, grey, channels=1)


def make_depth_lut():
    span = DEPTH_FAR_MM - DEPTH_NEAR_MM
    lut = bytearray(65536)
    for mm in range(1, 65536):
        lut[mm] = 255 - min(255, max(0, (mm - DEPTH_NEAR_MM) * 230 // span))
    return bytes(lut)


DEPTH_LUT = make_depth_lut()


def infrared_lut(values):
    """Auto-contrast for the infrared image: stretch the 2nd-98th percentile
    (taken from a sample of pixels) to the full 0-255 range."""
    sample = sorted(values[::17])
    low = sample[len(sample) // 50]
    high = max(low + 1, sample[-len(sample) // 50 - 1])
    lut = bytearray(65536)
    for v in range(low, 65536):
        lut[v] = min(255, (v - low) * 255 // (high - low))
    return lut


# Distance-tinted infrared: the hue comes from the depth (red near, through
# yellow and green, to blue far) and the brightness from the infrared image.
# Both are quantised to 64 levels so each pixel is a single table lookup.
TINT_LEVELS = 64
SHADE_LEVELS = 64
NO_DEPTH_ROW = TINT_LEVELS * SHADE_LEVELS  # pixels without depth stay grey


def make_tint_tables():
    span = DEPTH_FAR_MM - DEPTH_NEAR_MM
    depth_row = [NO_DEPTH_ROW] + [
        min(TINT_LEVELS - 1, max(0, (mm - DEPTH_NEAR_MM) * TINT_LEVELS // span)) * SHADE_LEVELS
        for mm in range(1, 65536)]
    table = []
    for tint in range(TINT_LEVELS):
        r, g, b = colorsys.hsv_to_rgb(tint / (TINT_LEVELS - 1) * 2 / 3, 1.0, 1.0)
        for shade in range(SHADE_LEVELS):
            # Never fully black, so the tint stays visible on dark surfaces;
            # the gamma lifts the mid-tones the speckled infrared lives in
            k = 255 * (0.45 + 0.55 * (shade / (SHADE_LEVELS - 1)) ** 0.6)
            table.append(bytes((int(r * k), int(g * k), int(b * k))))
    for shade in range(SHADE_LEVELS):
        table.append(bytes([int(255 * (shade / (SHADE_LEVELS - 1)) ** 0.6)] * 3))
    return depth_row, table


DEPTH_TINT_ROW, TINT_TABLE = make_tint_tables()


def distance_tinted_infrared(infrared, depth):
    """RGB pixels from aligned infrared and depth planes of the eyes' sensor."""
    shade = infrared_lut(infrared)
    return b"".join([TINT_TABLE[DEPTH_TINT_ROW[d] + (shade[v] >> 2)]
                     for v, d in zip(infrared, depth)])


def camera_idle_monitor():
    while True:
        time.sleep(1.0)
        if camera_handles and time.monotonic() - camera_last_used > CAMERA_IDLE_TIMEOUT:
            with camera_lock:
                if camera_handles and time.monotonic() - camera_last_used > CAMERA_IDLE_TIMEOUT:
                    print("Camera idle - releasing it")
                    unsubscribe_camera()


def stop_all_motions():
    """Stop running animations and behaviors started from /motion.

    NAOqi 2.5's ALAnimationPlayer has no stopAll() and ignores future
    cancellation, but every playing animation is also a running behavior,
    so it is stopped through ALBehaviorManager instead."""
    stop_driving()
    running = behavior_manager.getRunningBehaviors()
    for name in running:
        if name.startswith("animations/") or name in launched_behaviors:
            try:
                behavior_manager.stopBehavior(name)
            except Exception as e:
                print(f"Warning: Could not stop {name}: {e}")


def ensure_connected():
    """Fast check used by every request: is the qi session still up?

    It never reconnects itself (that could stall a request for ~20 s); a dead
    session is only marked as disconnected and connection_monitor() takes over."""
    if not is_connected or app is None:
        return False
    try:
        if app.isConnected():
            return True
    except Exception:
        pass
    mark_disconnected("session closed")
    return False


def session_alive():
    """Round-trip to the robot with a timeout (a dropped Wi-Fi link can
    otherwise leave calls hanging for minutes)."""
    try:
        if app is None or not app.isConnected():
            return False
        behavior_manager.getRunningBehaviors(_async=True).value(LIVENESS_TIMEOUT_MS)
        return True
    except Exception:
        return False


def mark_disconnected(reason):
    global is_connected, drive_active, last_connection_error
    if is_connected:
        print(f"Connection to Pepper lost ({reason}) - reconnecting automatically...")
    is_connected = False
    drive_active = False  # the watchdog can't reach the robot anyway
    last_connection_error = reason


def close_session():
    global app
    if app is not None:
        try:
            app.close()
        except Exception:
            pass
        app = None


def connection_monitor():
    global reconnect_attempts, last_connection_error
    delay = 2.0
    next_attempt = 0.0
    last_check = 0.0
    while True:
        time.sleep(0.5)
        if not want_connected:
            delay, next_attempt = 2.0, 0.0
            continue
        now = time.monotonic()
        if is_connected:
            if now - last_check < LIVENESS_INTERVAL:
                continue
            last_check = now
            if session_alive():
                continue
            with reconnect_lock:
                if is_connected and not session_alive():
                    mark_disconnected("robot not responding")
                    next_attempt = 0.0
            continue
        if now < next_attempt:
            continue
        with reconnect_lock:
            if not want_connected or is_connected:
                continue
            reconnect_attempts += 1
            print(f"Reconnect attempt {reconnect_attempts} to {PEPPER_IP}...")
            try:
                connect_pepper(reconnecting=True)
                print("Reconnected to Pepper")
                reconnect_attempts = 0
                last_connection_error = None
                delay = 2.0
            except Exception as e:
                last_connection_error = str(e) or type(e).__name__
                print(f"Reconnect failed: {last_connection_error} - retrying in {delay:.0f}s")
                next_attempt = time.monotonic() + delay
                delay = min(delay * 2, RECONNECT_MAX_DELAY)


def connect_pepper(reconnecting=False):
    """Connect and prepare the robot. On an automatic reconnect the robot is
    not woken up and the tablet brightness is left alone: after a network
    drop Pepper keeps its state, and a robot that was put to rest (e.g. by
    Emergency Stop) must never start moving on its own."""
    global tablet, tts, animation_player, motion, behavior_manager, audio_device, memory, battery, video_device, app, is_connected
    global camera_handles, camera_index

    # Clean up old session if any. A plain qi.Session is used rather than
    # qi.Application: only one Application may exist per process, so creating
    # a second one on reconnect fails with "Application was already initialized".
    is_connected = False
    close_session()

    session = qi.Session()
    try:
        session.connect(f"tcp://{PEPPER_IP}:{PEPPER_PORT}", _async=True).value(CONNECT_TIMEOUT_MS)
    except Exception as e:
        try:
            session.close()
        except Exception:
            pass
        if "timeout" in str(e).lower():
            raise RuntimeError(f"Pepper at {PEPPER_IP} did not answer within {CONNECT_TIMEOUT_MS // 1000} s")
        raise
    app = session

    tablet = session.service("ALTabletService")
    tts = session.service("ALTextToSpeech")
    animation_player = session.service("ALAnimationPlayer")
    motion = session.service("ALMotion")
    behavior_manager = session.service("ALBehaviorManager")
    audio_device = session.service("ALAudioDevice")
    memory = session.service("ALMemory")
    battery = session.service("ALBattery")
    video_device = session.service("ALVideoDevice")
    # A subscription made over the old session is re-made on the next frame;
    # the old one (and any left by an earlier bridge) is released on the robot
    with camera_lock:
        camera_handles = []
        camera_index = None
        try:
            release_stale_subscriptions()
        except Exception as e:
            print(f"Warning: Could not check old camera subscriptions: {e}")

    if not reconnecting:
        try:
            tablet.setBrightness(1.0)
        except Exception:
            pass
        # Every session starts with obstacle avoidance on
        try:
            set_obstacle_avoidance(True)
        except Exception as e:
            print(f"Warning: Could not enable obstacle avoidance: {e}")

    try:
        tablet.wakeUp()
    except Exception:
        pass

    # Disable Autonomous Life so the robot doesn't fall asleep or scratch mid-behavior.
    # Re-applying "disabled" resets the animation player, so after a reconnect
    # it is only done if the robot actually came back in another state (reboot).
    try:
        autonomous_life = session.service("ALAutonomousLife")
        if not reconnecting or autonomous_life.getState() != "disabled":
            autonomous_life.setState("disabled")
            print("Autonomous Life disabled")
    except Exception as e:
        print(f"Warning: Could not disable Autonomous Life: {e}")

    # A reconnect after a network drop leaves whatever the robot is doing alone
    if not reconnecting:
        # Stop any currently running behaviors (e.g. head scratch on startup)
        try:
            behavior_manager.stopAllBehaviors()
            print("All behaviors stopped")
        except Exception as e:
            print(f"Warning: Could not stop behaviors: {e}")

        # Stop any running animations
        try:
            stop_all_motions()
            print("All animations stopped")
        except Exception as e:
            print(f"Warning: Could not stop animations: {e}")

    # Disable background idle movements (head scratch, breathing sway, etc.)
    try:
        background_movement = session.service("ALBackgroundMovement")
        background_movement.setEnabled(False)
        print("Background movement disabled")
    except Exception as e:
        print(f"Warning: Could not disable background movement: {e}")

    # Disable basic awareness (person/head tracking)
    try:
        basic_awareness = session.service("ALBasicAwareness")
        basic_awareness.stopAwareness()
        basic_awareness.setEnabled(False)
        print("Basic awareness (head tracking) disabled")
    except Exception as e:
        print(f"Warning: Could not disable basic awareness: {e}")

    # Stop the tracker (handles physical head-following)
    try:
        tracker = session.service("ALTracker")
        tracker.stopTracker()
        tracker.unregisterAllTargets()
        print("Tracker stopped")
    except Exception as e:
        print(f"Warning: Could not stop tracker: {e}")

    # Wake up the robot (enable motor stiffness) so animations work
    if not reconnecting:
        try:
            motion.wakeUp()
            print("Robot is now awake")
        except Exception as e:
            print(f"Warning: Could not wake up robot: {e}")

    is_connected = True
    print(f"Connected to Pepper at {PEPPER_IP}:{PEPPER_PORT}")


def main():
    global HTTP_PORT

    parser = argparse.ArgumentParser()

    # HTTP server port (optional, defaults to 8000)
    parser.add_argument("--http-port", type=int, default=8000)

    args = parser.parse_args()
    HTTP_PORT = args.http_port

    server = ThreadingHTTPServer(("0.0.0.0", args.http_port), Handler)
    threading.Thread(target=drive_watchdog, daemon=True).start()
    threading.Thread(target=connection_monitor, daemon=True).start()
    threading.Thread(target=camera_idle_monitor, daemon=True).start()

    print(f"=" * 50)
    print(f"Pepper Controller Server")
    print(f"=" * 50)
    print(f"Server running on port: {args.http_port}")
    print(f"Open in browser: http://localhost:{args.http_port}/controller.html")
    print(f"")
    print(f"Use the web interface to connect to Pepper.")
    print(f"=" * 50)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping - releasing the camera")
    finally:
        # Pepper keeps subscriptions of a stopped bridge until they are released
        if is_connected:
            release_camera()


if __name__ == "__main__":
    main()
