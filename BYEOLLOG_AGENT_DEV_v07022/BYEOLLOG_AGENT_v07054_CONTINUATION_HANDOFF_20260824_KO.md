# 별록 에이전트 v0.7.0.54 인계

기준선은 `v0.7.0.54`이다. v0.7.0.53 산출물은 불변으로 유지한다.

## 추첨권 정책

- `raffleTicketUnit`은 사용자가 직접 입력하는 별풍선 기준 금액이다.
- `raffleAllowMultiples=false`: 후원 금액이 기준과 정확히 같을 때 1장, 그 밖에는 0장.
- `raffleAllowMultiples=true`: `floor(후원 금액 / 기준 금액)`장. 나머지는 버린다.
- 한 기준 단위당 지급량은 항상 1장이고 별도의 `단위당 티켓 수` 설정은 없다.
- v0.7.0.53에서 저장되어 `allowMultiples`가 없는 규칙은 호환을 위해 true로 해석한다.

## 추가 계약

- 지급 GIF: `ticketOverlayPositionX/Y`, `ticketOverlayScalePercent`
- 추첨 GIF: `drawOverlayPositionX/Y`, `drawOverlayScalePercent`
- 저장 RPC: `public.save_guided_rule_v10`
- 테스트 RPC: `public.dispatch_guided_rule_test_v2`
- 테스트 실행 kind: `test_sequence`; 지급 화면 뒤 추첨 화면을 송출하며 ledger를 변경하지 않는다.
- 당첨 티켓 개수는 `draw_raffle_v1`의 `winnerCount`로 1~100 사이에서 사용자가 정한다.

## 검증과 배포

- Agent 계약 125/125, Local Agent 342 assertions, Server 29/29 통과.
- Supabase Production migration 적용 및 임의 기준 33/50 계산 확인 완료.
- Vercel Preview `dpl_E5ck7gdYrjvUCxwHG4Wzvb4ZoKqK`, Production `dpl_7giE4aahV6n4maKjtVn4ycPRYc1G` READY.
- 운영 안정 피드는 v0.7.0.54 / releaseSequence 7054를 제공한다.
- 자동업데이트 ZIP SHA-256: `4007cc616528a1a9ceac44827e6931e3387e79fd33a14dc551346e035747e03d`.

## 다음 확인

- 실제 OBS 1920×1080 브라우저 소스에서 두 이미지의 개별 위치·크기와 테스트 송출을 육안 확인한다.
- Authenticode는 외부 공개 코드서명 인증서 준비 후 별도 진행한다.
