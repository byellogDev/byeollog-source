# 구성요소별 상태

2026-10-23 Git 정리 시 기존 배포 기록을 대조한 목록입니다. 실시간 서비스 건강 상태나 모든 기능의 종단 검증을 새로 보증하는 문서는 아닙니다. 각 문서의 확인 시각과 한계를 함께 읽습니다.

| 영역 | 기록상 상태 | 근거·남은 범위 |
| --- | --- | --- |
| Windows Agent | 1.0.0.60 운영 반영 | [크기 조절 저장 수정](releases/2026-10-22-agent-10060.md). 고객 PC 재확인 별도 |
| SOOP 수집 | 전체 계정 direct 기본 경로 전환 | [직접 WebSocket 운영 반영](releases/2026-10-11-direct-all-production.md). tools의 과거 비교 실험은 별도 연구 자료 |
| 업보 수집 | 오버레이 결과 기준 처리 | [운영 전환](releases/2026-10-11-overlay-authority.md). 시험 자료를 임의로 운영 데이터에 합산하지 않음 |
| 호스트 | iwinv 이전, NCP 반납 | [이전](releases/2026-10-05-iwinv-migration.md), [반납](releases/2026-10-06-ncp-retirement.md). NCP 구성 파일은 역사·복구 참고용 |
| 출발 통신 제어 | 운영 도입, 반복 API 장애 진단 보강 | [도입](releases/2026-10-15-auto-egress-production.md), [진단 확대](releases/2026-10-20-egress-request-telemetry.md). 공급자 API 반복 장애의 근본 해결은 미완료 |
| Minecraft 연결 | 계정 연결·인증 일부 운영 반영 | [부분 반영](releases/2026-09-24-minecraft-production.md). 후원→게임 동작 전달 미구현, 실제 사용자 인증 전체 흐름 추가 검증 필요 |
| 야추 | 별도 서비스의 운영 이전 기록 | [분리 구조](releases/2026-10-16-yatch-independent-hosting.md). 게임 구현·인증·DB는 별록과 분리 |
| 소스 그래프 | 로컬 분석 도구 | [그래프](releases/2026-10-13-interactive-source-graph.md). 생성물 `graphify-out/`은 Git 제외, 삭제하지 않음 |

## 코드·실험·운영의 경계

`apps/`와 `services/`는 구성요소 소스, `tools/*-lab/`와 `docs/research/`는 비교 실험과 진단 자료입니다. 연구 도구가 main에 있다는 이유로 실행하거나 운영 기능으로 소개하지 않습니다. 과거 실행 중단·권한·용량 제한은 각 도구의 문서를 따릅니다.

`main`의 전체 파일이 모든 운영 프로젝트에 동시에 배포됐다는 뜻은 아닙니다. 구성요소별 검증된 후보·파일 목록·이전 배포는 비공개 운영 증거로 관리하고, 공개 가능한 검증 요약은 릴리스 문서에 남깁니다.

## Git 관리에서 확인된 제한

9월 23일 이후 변경이 장기 PR에 누적되어 기본 브랜치가 운영 기록을 따라가지 못했습니다. [2026-10-23 정리](releases/2026-10-23-repository-governance.md)에서 기존 이력을 보존해 통합합니다. 과거 검토 절차가 잘 지켜졌다고 소급해 주장하지 않습니다. 비공개 저장소의 브랜치 보호는 현재 요금제 제한으로 강제할 수 없습니다.
