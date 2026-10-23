# GitHub Releases 누락 보완 · 2026-09-29

## 상태와 범위

본 저장소 GitHub Releases에 누락된 9개 기록 게시 완료. 코드 병합·운영 배포·기존 태그 이동은 하지 않았습니다. 9월 24~29일 기록의 실제 작업일과 이번 보완 게시일을 구분합니다.

## 목적과 변경 전 문제

본 저장소의 Releases에는 9월 23일 서비스 릴리스 두 개만 있었습니다. 이후 Markdown 기록은 작업 브랜치에, 설치 파일 릴리스는 별도 byeollog-releases 저장소에 게시해 본 저장소 Releases에서 보이지 않았습니다. 문서·태그·바이너리 게시를 GitHub Release 게시와 구분하지 않은 완료 기준 누락입니다. 확인 당시 main에는 9월 23일 문서 두 개만 있었고 PR #4는 다른 기능 브랜치를 대상으로 열린 draft 상태였습니다.

## 게시 내용

| 작업일 | 본 저장소 GitHub Release | 상태 |
| --- | --- | --- |
| 2026-09-24 | [2026.09.24 · 마크 계정 연동·수집 관측 API](https://github.com/byellogDev/byeollog/releases/tag/service-2026.09.24) | 정식 기록 |
| 2026-09-25 | [2026.09.25 · 직접 수집 독립 관측·유휴 연결 수정 [연구]](https://github.com/byellogDev/byeollog/releases/tag/research-2026.09.25) | 연구 시험판 |
| 2026-09-26 | [2026.09.26 · 별풍선 통계·리포트·반복 요청 절감](https://github.com/byellogDev/byeollog/releases/tag/service-2026.09.26) | 정식 기록 |
| 2026-09-27 | [2026.09.27 · 방종 프레임·관측 소켓 구분 보완 [연구]](https://github.com/byellogDev/byeollog/releases/tag/research-2026.09.27) | 연구 시험판 |
| 2026-09-28 | [2026.09.28 · 설치 바로가기·연결 알림 개선 및 연구 기록](https://github.com/byellogDev/byeollog/releases/tag/service-2026.09.28) | 정식 기록 |
| 2026-09-29 | [Agent 1.0.0.42 · 풍벽지 편집 크기·오른쪽 끝 배치](https://github.com/byellogDev/byeollog/releases/tag/agent-v1.0.0.42) | 정식 기록 |
| 2026-09-29 | [Agent 1.0.0.43 · 백두산 실시간 풍벽지](https://github.com/byellogDev/byeollog/releases/tag/agent-v1.0.0.43) | 정식 기록 |
| 2026-09-29 | [설치기 1.0.0.43-r2 · 설치 완료 경로 인코딩 수정](https://github.com/byellogDev/byeollog/releases/tag/installer-v1.0.0.43-r2) | 정식 기록 |
| 2026-09-29 | [Agent 1.0.0.44 · 백두산 만들기·관리 UI 개선](https://github.com/byellogDev/byeollog/releases/tag/agent-v1.0.0.44) | 정식 기록 |

최신 릴리스는 Agent 1.0.0.44로 지정했습니다. 각 본문에 목적·변경·검증·미검증·소스 커밋·PR·상세 복구 문서 및 해당 설치 파일 저장소를 연결했습니다. 연결한 33개 상세 문서는 공개 원격 커밋 5f17af75d278a6bb657dd4a49341026db8b5a997을 기준으로 합니다. 연구 내용이 함께 있는 날짜별 소스 스냅샷을 전체 구성요소의 운영 배포로 표현하지 않았습니다.

## 재발 방지

AGENTS.md, 개발 지침, 릴리스 템플릿에 본 저장소 Release 게시·본문 재조회·태그 커밋·Latest 확인을 완료 조건으로 추가했습니다. 문서가 작업 브랜치에만 있는 상태와 기본 브랜치에 반영된 상태도 구분합니다.

## 검증

- 게시 예정 본문 전체에 기존 게시 검사와 같은 비밀정보 탐지 규칙 적용, 탐지 0.
- GitHub API에서 9개 본문 일치, draft=false, 연구 2개 prerelease, Latest=agent-v1.0.0.44 확인.
- 각 태그는 실제 해당 기록 기준 커밋에 연결하고 기존 태그를 변경하지 않음.
- 기록만 변경하므로 앱 빌드나 실사용자 흐름을 반복 실행하지 않음. 공개 문서 게시와 운영 재검증을 구분함.

## 사용자 영향과 복구

기본 Releases 화면에서 이후 기록을 읽을 수 있습니다. main 소스/문서는 자동 병합하지 않았으며, 상세 문서 링크는 해당 문서가 존재하는 원격 커밋에 고정했습니다. 잘못된 본문은 해당 Release를 수정하고, 잘못된 상태 표시는 정정합니다. 복구를 위해 운영 배포·설치 자산·기존 태그를 삭제할 필요가 없습니다.

## 제거·보존한 파일과 근거

삭제 없음. 과거 릴리스·기존 설치 자산 보존. 비공개 API 확인 영수증은 .local에 남기며 게시하지 않습니다.

## 관련 PR·커밋·이전 버전

- [전체 GitHub Releases](https://github.com/byellogDev/byeollog/releases)
- [PR #4](https://github.com/byellogDev/byeollog/pull/4)
- 기존 후보/운영 릴리스 문서는 이 보완 기록과 함께 보존합니다.
