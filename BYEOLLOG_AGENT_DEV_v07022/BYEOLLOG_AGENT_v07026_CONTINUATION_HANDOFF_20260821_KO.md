# 별록 에이전트 v0.7.0.26 인계

## 기준선

- Version: `0.7.0.26`
- Informational/UI: `0.7.0-public.24`
- 공개 표시: `0.7.0 공개판 24`
- Tester ZIP: `byeollog_agent_v07026_WEFLAB_RECOVERY_WIN_X64.zip`

## 이번 변경

- 수집 중 위플랩 세션 만료 시 로그인 화면과 명확한 재로그인 안내를 한 번 표시한다.
- 재로그인 성공 감지 후 진행 중인 수집 스크립트를 자동으로 재연결한다.
- 위플랩 비밀번호·쿠키는 별도 저장하거나 복사하지 않는다.
- 룰렛 결과는 ASCII `&`만 구분자로 사용해 각 조각을 별도 결과로 저장한다.
- 룰렛 액션은 최소 별풍선 없이 결과 이름만으로 실행한다.
- 후원 액션은 고정 별풍선 정확 일치 조건을 유지한다.
- 오버레이 안내 문구는 특정 아봉이 아니라 각 액션 설정을 기준으로 표시한다.

## 비회귀

- 기존 WebView2 프로필과 사용자 로그인 상태, `%LOCALAPPDATA%\ByeollogAgent` 데이터, 수집 세션, 규칙, 업로드 큐를 보존한다.
- 기존 Collector API·JSON·source_scope와 로컬 Agent 실행 계약을 변경하지 않는다.
- 서버·DB·Auth·Storage·Edge Function·Vercel은 변경하지 않았다.

## 검증

- Node 계약 테스트와 AgentStoreTests를 모두 통과해야 한다.
- 새 EXE는 `0.7.0.26 / 0.7.0-public.24`여야 한다.
- Tester ZIP manifest와 왕복 압축 무결성, 외부 SHA-256을 확인한다.
- 실제 사용자 PC에서는 수집 중 위플랩 로그아웃 → 안내 표시 → 재로그인 → 자동 수집 재연결을 한 번 관찰한다.
