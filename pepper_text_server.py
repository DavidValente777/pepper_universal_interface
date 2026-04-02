import argparse
import qi
import json
import base64
import html as html_module
import os
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
app = None
DISPLAY_URL_BASE = None
is_connected = False
reconnect_lock = False  # prevent concurrent reconnect attempts

# Get the directory where the script is located
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        SimpleHTTPRequestHandler.end_headers(self)

    def do_GET(self):
        global tablet, DISPLAY_URL_BASE, is_connected, HOST_IP, PEPPER_IP

        parsed = urlparse(self.path)

        # Return connection status (actually verifies the qi session is alive)
        if parsed.path == "/status":
            # If we think we're connected, verify it's still alive
            if is_connected:
                ensure_connected()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            status = {
                "connected": is_connected,
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

            # Clean up any previous image
            for old_file in os.listdir(os.getcwd()):
                if old_file.startswith("temp_pepper_image_"):
                    try:
                        os.remove(os.path.join(os.getcwd(), old_file))
                    except Exception:
                        pass

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

        # Default: serve files normally
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        global tablet, tts, DISPLAY_URL_BASE, is_connected, PEPPER_IP, HOST_IP, app, motion

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
                # Update global variables
                PEPPER_IP = pepper_ip
                HOST_IP = host_ip
                DISPLAY_URL_BASE = f"http://{host_ip}:{HTTP_PORT}"

                # Connect to Pepper
                connect_pepper()

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            except Exception as e:
                is_connected = False
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            return

        # Handle disconnect request
        if self.path == "/disconnect":
            is_connected = False
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
                    tts.say(text)
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

            # Build minimal HTML with the image as a data URI so Pepper's
            # tablet does not need to fetch anything from this server.
            inline_html = (
                '<html><body style="margin:0;padding:0;height:100vh;display:flex;'
                'align-items:center;justify-content:center;background:#fff;overflow:hidden">'
                f'<img src="{image_data_uri}" style="max-width:100%;max-height:100vh;object-fit:contain">'
                '</body></html>'
            )
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
                    animation_player.run(motion_name)
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
                animation_player.stopAll()
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
                    animation_player.stopAll()
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


def ensure_connected():
    """Check if the qi session is still alive; if not, auto-reconnect.
    Returns True if connected (possibly after reconnect), False if reconnect failed."""
    global is_connected, reconnect_lock

    if not is_connected or PEPPER_IP is None:
        return False

    # Quick liveness check — call a lightweight method on the session
    try:
        behavior_manager.getRunningBehaviors()
        return True
    except Exception:
        pass

    # Session is dead — attempt reconnect
    if reconnect_lock:
        return False  # another thread is already reconnecting

    reconnect_lock = True
    print("Connection lost — attempting auto-reconnect...")
    try:
        connect_pepper()
        print("Auto-reconnect successful")
        return True
    except Exception as e:
        print(f"Auto-reconnect failed: {e}")
        is_connected = False
        return False
    finally:
        reconnect_lock = False


def connect_pepper():
    global tablet, tts, animation_player, motion, behavior_manager, app, is_connected

    # Clean up old session if any
    app = None

    app = qi.Application(["pepper_text_server", f"--qi-url=tcp://{PEPPER_IP}:{PEPPER_PORT}"])
    app.start()
    session = app.session

    tablet = session.service("ALTabletService")
    tts = session.service("ALTextToSpeech")
    animation_player = session.service("ALAnimationPlayer")
    motion = session.service("ALMotion")
    behavior_manager = session.service("ALBehaviorManager")

    try:
        tablet.setBrightness(1.0)
    except Exception:
        pass

    try:
        tablet.wakeUp()
    except Exception:
        pass

    # Disable Autonomous Life so the robot doesn't fall asleep or scratch mid-behavior
    try:
        autonomous_life = session.service("ALAutonomousLife")
        autonomous_life.setState("disabled")
        print("Autonomous Life disabled")
    except Exception as e:
        print(f"Warning: Could not disable Autonomous Life: {e}")

    # Stop any currently running behaviors (e.g. head scratch on startup)
    try:
        behavior_manager.stopAllBehaviors()
        print("All behaviors stopped")
    except Exception as e:
        print(f"Warning: Could not stop behaviors: {e}")

    # Stop any running animations
    try:
        animation_player.stopAll()
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

    print(f"=" * 50)
    print(f"Pepper Controller Server")
    print(f"=" * 50)
    print(f"Server running on port: {args.http_port}")
    print(f"Open in browser: http://localhost:{args.http_port}/controller.html")
    print(f"")
    print(f"Use the web interface to connect to Pepper.")
    print(f"=" * 50)

    server.serve_forever()


if __name__ == "__main__":
    main()
