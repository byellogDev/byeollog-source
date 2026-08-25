import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]


class WinnerGatewayContractTests(unittest.TestCase):
    def test_service_uses_the_pinned_cosyvoice_generation(self) -> None:
        main = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
        engine = (ROOT / "app" / "engine.py").read_text(encoding="utf-8")
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn('SERVICE_VERSION = "raffle-winner-cosyvoice3-v1"', main)
        self.assertIn("from cosyvoice.cli.cosyvoice import AutoModel", engine)
        self.assertIn("ZERO_SHOT_SPEAKER_ID", engine)
        self.assertIn("074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc", dockerfile)
        self.assertIn("29e01c4e8d000f4bcd70751be16fa94bf3d85a18", dockerfile)
        self.assertIn("python -m pip uninstall --yes wetext", dockerfile)
        self.assertIn("text_frontend=False", engine)
        self.assertNotIn("MeloTTS", engine)

    def test_response_echoes_the_verified_identity_and_audio_digest(self) -> None:
        source = (Path(__file__).parents[1] / "app" / "main.py").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "hmac.compare_digest(voice_key(request.actorName), request.voiceKey)",
            source,
        )
        self.assertIn('"x-byeollog-audio-sha256": digest', source)
        self.assertIn('"x-byeollog-voice-key": request.voiceKey', source)
        self.assertIn('"x-byeollog-voice-version": SERVICE_VERSION', source)
        self.assertIn('extra="forbid"', source)

    def test_memory_cache_binds_the_exact_phrase_to_the_voice_key(self) -> None:
        source = (ROOT / "app" / "engine.py").read_text(encoding="utf-8")
        self.assertIn('text_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()', source)
        self.assertIn('hmac.compare_digest(cached_text_digest, text_digest)', source)
        self.assertIn('raise RuntimeError("voice cache identity mismatch")', source)
        self.assertIn('self._cache[cache_key] = (text_digest, wav)', source)

    def test_native_roulette_uses_a_separate_exact_text_identity(self) -> None:
        source = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
        text_source = (ROOT / "app" / "text.py").read_text(encoding="utf-8")
        self.assertIn('@app.post("/v1/roulette-result"', source)
        self.assertIn("roulette_result_voice_key(phrase)", source)
        self.assertIn('ROULETTE_RESULT_KEY_DOMAIN = "native-roulette-result-v1|"', text_source)
        self.assertIn('extra="forbid"', source)


if __name__ == "__main__":
    unittest.main()
