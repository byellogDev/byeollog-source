import unittest

from app.text import readable_nickname, voice_key, winner_phrase


class WinnerTextTests(unittest.TestCase):
    def test_korean_name_keeps_honorific_once(self) -> None:
        self.assertEqual(winner_phrase("별님"), "별님, 당첨을 축하드려요!")

    def test_unreadable_latin_is_spelled_deterministically(self) -> None:
        self.assertEqual(readable_nickname("gahdh"), "지 에이 에이치 디 에이치")

    def test_decorations_are_silent_and_digits_are_readable(self) -> None:
        self.assertEqual(readable_nickname("⭐G-A_123⭐"), "지 에이 일 이 삼")

    def test_voice_key_is_bound_to_raw_database_name(self) -> None:
        self.assertEqual(
            voice_key("별"),
            "0128f8f03bb28521b80f1132051ac2bbacfb4b50d11026574481fc2c1c92e032",
        )


if __name__ == "__main__":
    unittest.main()
