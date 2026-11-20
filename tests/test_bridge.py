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
import io
import shutil
import types
import unittest
import wave
import urllib.error
import urllib.request
from unittest.mock import MagicMock

sys.modules.setdefault("qi", types.ModuleType("qi"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import bridge  # noqa: E402


def tiny_wav():
    """0.1 s of silence in Pepper's TTS format (16-bit mono 22050 Hz)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(b"\0\0" * 2205)
    return buf.getvalue()


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
        bridge.file_manager = MagicMock()
        bridge.file_manager.getFileContents.return_value = bytearray(tiny_wav())
        bridge.FFMPEG = shutil.which("ffmpeg")

    def tearDown(self):
        self.tmp.cleanup()

    def request_raw(self, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode("utf-8"),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type"), e.read()

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

    # /speech-audio

    def test_speech_audio_saves_with_pitch_and_returns_wav_without_ffmpeg(self):
        bridge.FFMPEG = None
        bridge.voice_pitch = 120
        status, ctype, body = self.request_raw("/speech-audio", {"text": "Hello"})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "audio/wav")
        self.assertEqual(body, tiny_wav())
        bridge.tts.sayToFile.assert_called_once_with("\\vct=120\\ Hello", "/home/nao/pepper_controller_speech.wav")
        bridge.file_manager.getFileContents.assert_called_once_with("pepper_controller_speech.wav")
        bridge.tts.say.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_speech_audio_is_mp3_when_ffmpeg_is_available(self):
        status, ctype, body = self.request_raw("/speech-audio", {"text": "Hello"})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "audio/mpeg")
        self.assertTrue(body.startswith(b"ID3") or body[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"), body[:4])

    def test_speech_audio_needs_text(self):
        status, _, _ = self.request_raw("/speech-audio", {"text": "  "})
        self.assertEqual(status, 400)

    def test_speech_audio_needs_connection(self):
        bridge.is_connected = False
        status, _, _ = self.request_raw("/speech-audio", {"text": "Hello"})
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
