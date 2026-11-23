"""Bridge HTTP endpoints with the robot replaced by mocks.

The real `qi` library is not needed: a stub module is installed before
bridge.py is imported. Run with:
    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import base64
import http.client
import json
import os
import sys
import tempfile
import threading
import time
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
        bridge.voice_speed = 100
        bridge.voice_word_gap = 0
        bridge.tts = MagicMock()
        bridge.animated_speech = MagicMock()
        bridge.leds = MagicMock()
        bridge.file_manager = MagicMock()
        bridge.file_manager.getFileContents.return_value = bytearray(tiny_wav())
        bridge.FFMPEG = shutil.which("ffmpeg")
        bridge.HOST_IP = "10.0.0.5"
        bridge.HTTP_PORT = 8000
        bridge.audio_player = MagicMock()
        stream = bridge.audio_player.playWebStream.return_value
        stream.isFinished.return_value = False  # still playing after the start wait
        bridge.sounds.clear()

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
        bridge.tts.say.assert_called_once_with("\\vct=100\\ \\rspd=100\\ Hi")
        bridge.animated_speech.say.assert_not_called()
        bridge.tts.stopAll.assert_not_called()

    def test_speak_animated_uses_animated_speech(self):
        status, _ = self.request("POST", "/speak", {"text": "Hi", "animated": True})
        self.assertEqual(status, 200)
        bridge.animated_speech.say.assert_called_once_with("\\vct=100\\ \\rspd=100\\ Hi", {"bodyLanguageMode": "random"})
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

    # /set-speed

    def test_set_speed_is_clamped_and_used_for_speech(self):
        status, body = self.request("POST", "/set-speed", {"value": 20})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["value"], 50)
        status, body = self.request("POST", "/set-speed", {"value": 75})
        self.assertEqual(json.loads(body)["value"], 75)
        self.request("POST", "/speak", {"text": "Hi"})
        bridge.tts.say.assert_called_once_with("\\vct=100\\ \\rspd=75\\ Hi")

    # /play-sound, /sound/<name>, /stop-sound

    MP3_URI = "data:audio/mpeg;base64," + base64.b64encode(b"ID3fake-mp3").decode()

    def test_play_sound_streams_it_from_the_bridge(self):
        status, body = self.request("POST", "/play-sound", {"audioData": self.MP3_URI})
        self.assertEqual(status, 200, body)
        bridge.audio_player.stopAll.assert_called_once_with()
        url, volume, pan = bridge.audio_player.playWebStream.call_args.args
        self.assertEqual((volume, pan), (1.0, 0.0))
        self.assertEqual(bridge.audio_player.playWebStream.call_args.kwargs, {"_async": True})
        self.assertRegex(url, r"^http://10\.0\.0\.5:8000/sound/[0-9a-f]{16}\.mp3$")
        # Pepper fetches that URL from the bridge
        with urllib.request.urlopen(url.replace("10.0.0.5", "127.0.0.1").replace(":8000", f":{self.port}")) as r:
            self.assertEqual(r.headers.get("Content-Type"), "audio/mpeg")
            self.assertEqual(r.read(), b"ID3fake-mp3")

    def test_same_sound_reuses_its_url(self):
        self.request("POST", "/play-sound", {"audioData": self.MP3_URI})
        self.request("POST", "/play-sound", {"audioData": self.MP3_URI})
        urls = {c.args[0] for c in bridge.audio_player.playWebStream.call_args_list}
        self.assertEqual(len(urls), 1)
        self.assertEqual(len(bridge.sounds), 1)

    def test_play_sound_reports_a_stream_that_fails_to_start(self):
        stream = bridge.audio_player.playWebStream.return_value
        stream.isFinished.return_value = True
        stream.hasError.return_value = True
        stream.error.return_value = "could not open"
        status, body = self.request("POST", "/play-sound", {"audioData": self.MP3_URI})
        self.assertEqual(status, 500)
        self.assertIn("could not open", json.loads(body)["error"])

    def test_play_sound_refuses_non_audio(self):
        for bad in ("data:image/png;base64,AAAA", "data:audio/ogg;base64,AAAA", "data:audio/mpeg;base64,***", "", None):
            status, body = self.request("POST", "/play-sound", {"audioData": bad})
            self.assertEqual(status, 400, bad)
        bridge.audio_player.playWebStream.assert_not_called()

    def test_play_sound_needs_the_robot(self):
        bridge.is_connected = False
        status, _ = self.request("POST", "/play-sound", {"audioData": self.MP3_URI})
        self.assertEqual(status, 503)

    def test_unknown_sound_is_404(self):
        status, _ = self.request("GET", "/sound/0000000000000000.mp3")
        self.assertEqual(status, 404)

    def test_sound_cache_keeps_the_latest_few(self):
        for i in range(bridge.SOUND_CACHE_SIZE + 3):
            bridge.store_sound("data:audio/wav;base64," + base64.b64encode(f"RIFF{i}".encode()).decode())
        self.assertEqual(len(bridge.sounds), bridge.SOUND_CACHE_SIZE)

    # Dance along: repeats while the sound plays

    HEY = "animations/Stand/Gestures/Hey_1"

    class FakeSong:
        """A playWebStream future that finishes when the test says so."""
        def __init__(self):
            self.ended = threading.Event()

        def wait(self, ms):
            self.ended.wait(ms / 1000)

        def isFinished(self):
            return self.ended.is_set()

        def hasError(self):
            return False

    def start_dance_along(self):
        """Plays a sound with the Hey dance; each dance takes 0.35 s unless stopped."""
        song = self.FakeSong()
        bridge.audio_player.playWebStream.return_value = song
        bridge.SOUND_START_WAIT_MS = 50
        bridge.motion = MagicMock()
        bridge.behavior_manager = MagicMock()
        stopped = threading.Event()
        dancing = threading.Event()
        runs = []

        def run(name):
            runs.append(name)
            stopped.clear()
            dancing.set()
            stopped.wait(0.35)
            dancing.clear()

        def stop(name):
            stopped.set()

        bridge.animation_player = MagicMock()
        bridge.animation_player.run.side_effect = run
        bridge.behavior_manager.getRunningBehaviors.side_effect = lambda: [self.HEY] if dancing.is_set() else []
        bridge.behavior_manager.stopBehavior.side_effect = stop
        status, body = self.request("POST", "/play-sound", {"audioData": self.MP3_URI, "motion": self.HEY})
        self.assertEqual(status, 200, body)
        return song, runs

    def test_dance_along_repeats_until_the_sound_ends_then_stops(self):
        song, runs = self.start_dance_along()
        time.sleep(1.0)
        self.assertGreaterEqual(len(runs), 2, "the dance repeated while the song played")
        self.assertEqual(set(runs), {self.HEY})
        song.ended.set()
        time.sleep(0.5)
        bridge.behavior_manager.stopBehavior.assert_called_with(self.HEY)
        count = len(runs)
        time.sleep(0.5)
        self.assertEqual(len(runs), count, "no more dancing after the song ended")

    def test_stop_motion_ends_the_dance_along(self):
        song, runs = self.start_dance_along()
        time.sleep(0.5)
        status, _ = self.request("POST", "/stop-motion", {})
        self.assertEqual(status, 200)
        time.sleep(0.2)
        count = len(runs)
        time.sleep(0.6)
        self.assertEqual(len(runs), count, "the dance doesn't come back while the song still plays")
        song.ended.set()

    def test_dance_along_must_be_installed(self):
        bridge.behavior_manager = MagicMock()
        bridge.behavior_manager.isBehaviorInstalled.return_value = False
        status, body = self.request("POST", "/play-sound", {"audioData": self.MP3_URI, "motion": "my_app/dance"})
        self.assertEqual(status, 500)
        self.assertIn("not installed", json.loads(body)["error"])
        bridge.audio_player.playWebStream.assert_not_called()

    def test_stop_sound(self):
        status, _ = self.request("POST", "/stop-sound", {})
        self.assertEqual(status, 200)
        bridge.audio_player.stopAll.assert_called_once_with()

    # /set-word-gap

    def test_word_gap_pauses_between_plain_words_only(self):
        status, body = self.request("POST", "/set-word-gap", {"value": 999})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["value"], 300)
        self.request("POST", "/set-word-gap", {"value": 120})
        self.request("POST", "/speak", {"text": "Hello  there ^start(animations/Stand/Gestures/Hey_1) \\pau=500\\ friend"})
        bridge.tts.say.assert_called_once_with(
            "\\vct=100\\ \\rspd=100\\ Hello \\pau=120\\ there ^start(animations/Stand/Gestures/Hey_1) \\pau=500\\ friend")

    def test_word_gap_off_leaves_text_alone(self):
        self.assertEqual(bridge.with_word_gaps("a  b", 0), "a  b")
        self.assertEqual(bridge.with_word_gaps("a b c", 50), "a \\pau=50\\ b \\pau=50\\ c")

    # /speech-audio

    def test_speech_audio_saves_with_pitch_and_returns_wav_without_ffmpeg(self):
        bridge.FFMPEG = None
        bridge.voice_pitch = 120
        bridge.voice_speed = 80
        status, ctype, body = self.request_raw("/speech-audio", {"text": "Hello"})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "audio/wav")
        self.assertEqual(body, tiny_wav())
        bridge.tts.sayToFile.assert_called_once_with("\\vct=120\\ \\rspd=80\\ Hello", "/home/nao/pepper_controller_speech.wav")
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
