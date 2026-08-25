import unittest

from app.text import (
    readable_nickname,
    roulette_result_phrase,
    roulette_result_voice_key,
    voice_key,
    winner_phrase,
)


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

    def test_roulette_result_key_is_bound_to_the_exact_spoken_phrase(self) -> None:
        self.assertEqual(roulette_result_phrase("  꽝, 당첨!  "), "꽝, 당첨!")
        self.assertEqual(
            roulette_result_voice_key("꽝, 당첨!"),
            "6f9ec539d45e70a96353db314a23831b0c4c4a7268829d3378e0af27624bc7a0",
        )
        self.assertNotEqual(
            roulette_result_voice_key("꽝, 당첨!"),
            roulette_result_voice_key("꽝 당첨!"),
        )

    def test_roulette_result_rejects_control_characters(self) -> None:
        with self.assertRaises(ValueError):
            roulette_result_phrase("당첨\n다음")


if __name__ == "__main__":
    unittest.main()
