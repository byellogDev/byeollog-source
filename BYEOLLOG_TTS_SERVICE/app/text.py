from __future__ import annotations

import hashlib
import re
import unicodedata

LATIN_NAMES = (
    "에이", "비", "씨", "디", "이", "에프", "지", "에이치", "아이", "제이",
    "케이", "엘", "엠", "엔", "오", "피", "큐", "알", "에스", "티",
    "유", "브이", "더블유", "엑스", "와이", "제트",
)
DIGIT_NAMES = ("영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def voice_key(actor_name: str) -> str:
    return hashlib.sha256(f"raffle-winner-voice-v1|{actor_name}".encode("utf-8")).hexdigest()


def readable_nickname(actor_name: str) -> str:
    source = unicodedata.normalize("NFC", actor_name or "").strip()
    if not 1 <= len(source) <= 120 or CONTROL.search(source):
        raise ValueError("invalid actor name")

    parts: list[str] = []
    korean: list[str] = []

    def flush_korean() -> None:
        if korean:
            parts.append("".join(korean))
            korean.clear()

    for character in source:
        if "가" <= character <= "힣":
            korean.append(character)
        elif "A" <= character <= "Z" or "a" <= character <= "z":
            flush_korean()
            parts.append(LATIN_NAMES[ord(character.upper()) - ord("A")])
        elif "0" <= character <= "9":
            flush_korean()
            parts.append(DIGIT_NAMES[ord(character) - ord("0")])
        else:
            flush_korean()
    flush_korean()
    readable = " ".join(part for part in parts if part).strip()
    if not readable:
        return "시청자"
    return readable[:240]


def winner_phrase(actor_name: str) -> str:
    nickname = readable_nickname(actor_name)
    display_name = nickname if nickname.endswith("님") else nickname + "님"
    return f"{display_name}, 당첨을 축하드려요!"
