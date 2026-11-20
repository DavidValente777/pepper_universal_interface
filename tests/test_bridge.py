"""Bridge HTTP endpoints with the robot replaced by mocks.

The real `qi` library is not needed: a stub module is installed before
bridge.py is imported. Run with:
    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import http.client
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from unittest.mock import MagicMock

sys.modules.setdefault("qi", types.ModuleType("qi"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bridge  # noqa: E402


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bridge.Handler.log_message = lambda *args: None  # keep test output quiet
        cls.server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bridge.STORY_PATH = os.path.join(self.tmp.name, "stories", "story.json")
        bridge.is_connected = True
        bridge.ensure_connected = lambda: True
        bridge.voice_pitch = 100
        bridge.tts = MagicMock()
        bridge.animated_speech = MagicMock()
        bridge.leds = MagicMock()

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8")

    # /speak

    def test_speak_plain_uses_tts(self):
        status, _ = self.request("POST", "/speak", {"text": "Hi"})
        self.assertEqual(status, 200)
        bridge.tts.say.assert_called_once_with("\\vct=100\\ Hi")
        bridge.animated_speech.say.assert_not_called()
        bridge.tts.stopAll.assert_not_called()

    def test_speak_animated_uses_animated_speech(self):
        status, _ = self.request("POST", "/speak", {"text": "Hi", "animated": True})
        self.assertEqual(status, 200)
        bridge.animated_speech.say.assert_called_once_with("\\vct=100\\ Hi", {"bodyLanguageMode": "random"})
        bridge.tts.say.assert_not_called()

    def test_speak_interrupt_stops_current_speech_first(self):
        status, _ = self.request("POST", "/speak", {"text": "Hi", "interrupt": True})
        self.assertEqual(status, 200)
        names = [c[0] for c in bridge.tts.mock_calls]
        self.assertEqual(names, ["stopAll", "say"])

    # /eyes

    def test_eyes_sets_face_leds(self):
        status, body = self.request("POST", "/eyes", {"color": "#ff8000"})
        self.assertEqual(status, 200, body)
        bridge.leds.fadeRGB.assert_called_once_with("FaceLeds", 0xFF8000, 0.2)

    def test_eyes_rejects_bad_colour(self):
        status, _ = self.request("POST", "/eyes", {"color": "red"})
        self.assertEqual(status, 400)
        bridge.leds.fadeRGB.assert_not_called()

    def test_eyes_needs_connection(self):
        bridge.is_connected = False
        status, _ = self.request("POST", "/eyes", {"color": "#ff8000"})
        self.assertEqual(status, 503)

    # /story

    def test_story_defaults_when_missing(self):
        status, body = self.request("GET", "/story")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"version": 1, "eyeColor": "#ffffff", "items": []})

    def test_story_round_trip_without_robot(self):
        bridge.is_connected = False
        story = {"version": 1, "eyeColor": "#112233",
                 "items": [{"id": "a", "type": "say", "text": "Hello", "played": False}]}
        status, _ = self.request("POST", "/story", story)
        self.assertEqual(status, 200)
        status, body = self.request("GET", "/story")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), story)
        self.assertEqual(os.listdir(os.path.dirname(bridge.STORY_PATH)), ["story.json"])

    def test_story_rejects_non_story(self):
        for bad in ([1, 2], {"items": "x"}):
            status, _ = self.request("POST", "/story", bad)
            self.assertEqual(status, 400, bad)

    def test_story_corrupt_file_is_500(self):
        os.makedirs(os.path.dirname(bridge.STORY_PATH))
        with open(bridge.STORY_PATH, "w") as f:
            f.write("{not json")
        status, body = self.request("GET", "/story")
        self.assertEqual(status, 500)
        self.assertFalse(json.loads(body)["success"])

    def test_story_too_large_is_413(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest("POST", "/story")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(50 * 1024 * 1024 + 1))
        conn.endheaders()
        conn.send(b"{}")
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()


if __name__ == "__main__":
    unittest.main()
