"""Offline, evidence-backed architecture view. Never contacts application services."""
import hashlib
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'graphify-out'
GIT = ['git', '-c', f'safe.directory={ROOT.as_posix()}']

def git(*args):
    return subprocess.check_output(GIT + list(args), cwd=ROOT).decode('utf-8').strip()

def evidence(path, anchor):
    data = (ROOT / path).read_bytes()
    lines = data.decode('utf-8-sig').splitlines()
    hits = [i + 1 for i, line in enumerate(lines) if anchor in line]
    if not hits:
        raise ValueError(f'Missing evidence: {path}: {anchor}')
    return dict(file=path, line=hits[0], anchor=anchor, matches=len(hits), sha256=hashlib.sha256(data).hexdigest())

COMPONENTS = [
    ('local', '로컬 방송 화면', '편집 화면 · 방송 프로그램의 브라우저 소스', 0, 0),
    ('agent', 'Windows Agent', '풍벽지 동기화 · 로컬 서버 · 결과 수집', 0, 1),
    ('overlay', '오버레이 수집 워커', '서버 수집 · Agent 인계 · 결과 등록', 0, 2),
    ('web', '웹 진입점', '사용자 화면 · 역할별 API 중계', 1, 0),
    ('gateway', 'SOOP 게이트웨이', '지속 연결 · 이벤트 · 암호화 전송 대기열', 1, 1),
    ('provider', '외부 플랫폼', 'SOOP · 후원알림 제공 서비스', 1, 2),
    ('admin', '관리 API', '로그인 · 업보 설정 · 관리 권한', 2, 0),
    ('collector', '수집 API', '수집 이벤트 · 소유권 · 처리', 2, 1),
    ('public', '공개 조회 API', '허용된 공개 조회만 제공', 2, 2),
    ('edge', 'Agent Edge API', '기기 인증 · 풍벽지 조회 · 작업 수신', 3, 0),
    ('db', 'DB · RPC', '함수 · 데이터 · 수집 권한 및 상태', 3, 1),
    ('backup', '백업 워커', '별도 계정과 제한된 RPC 권한', 3, 2),
]
edges = []

def link(a, b, title, kind, explanation, *refs):
    edges.append(dict(id=f'e{len(edges)+1}', source=a, target=b, title=title, kind=kind,
                      explanation=explanation, evidence=[evidence(*ref) for ref in refs]))

link('local', 'agent', '로컬 풍벽지 상태 조회', 'HTTP',
     'Agent 안의 HTML이 상대 경로를 조회하고 같은 클래스의 로컬 서버가 처리합니다. C# 안의 JavaScript 문자열이라 AST만으로는 이어지기 어렵습니다.',
     ('apps/windows-agent/ByeollogOverlayService.cs', "fetch('/overlay/wallpaper-state'"),
     ('apps/windows-agent/ByeollogOverlayService.cs', 'if (path == "/overlay/wallpaper-state")'))
link('agent', 'web', 'Agent 로그인·지원 요청', 'HTTP',
     'ProductionServerUrl과 operation 문자열을 통해 웹 진입점으로 요청합니다. 서버 주소의 현재 설정값은 읽지 않았습니다.',
     ('apps/windows-agent/VNextDevelopmentClient.cs', '"/api/login?operation=agent-support"'),
     ('apps/web/api/login.js', "endpoint:'/api/login'"))
link('web', 'admin', '관리 작업 전달', 'HTTP / 설정',
     '로그인 경로 선택 → 관리 런타임 프록시 → 내부 인증 래퍼 → agent-support 처리로 이어집니다. 역할 경계는 그대로 유지됩니다.',
     ('apps/web/lib/runtime-isolation.js', 'export function selectLoginRuntime'),
     ('apps/web/lib/runtime-proxy.js', 'const url=config.origin+endpoint'),
     ('apps/admin-runtime/api/login.js', "runtime:'admin'"),
     ('apps/admin-runtime/handlers/login.js', "if(operation==='agent-support')"))
link('gateway', 'web', '서명된 수집 이벤트 전달', 'HTTP / 라우팅',
     '게이트웨이 기본 경로가 웹 rewrite를 거쳐 login의 soop-gateway 작업으로 연결됩니다. 환경변수로 목적지를 바꿀 수 있습니다.',
     ('services/soop-gateway/services/soop-chat-gateway/index.mjs', 'const gatewayUrl='),
     ('services/soop-gateway/services/soop-chat-gateway/index.mjs', 'await fetch(gatewayUrl'),
     ('apps/web/vercel.json', '"destination": "/api/login?operation=soop-gateway"'))
link('web', 'collector', 'event·heartbeat 분기', 'HTTP / 권한',
     '같은 login URL이어도 본문의 kind에 따라 수집 런타임으로 전달됩니다. reconcile·lease는 관리 런타임으로 분기합니다.',
     ('apps/web/lib/runtime-isolation.js', "COLLECTOR_SOOP_KINDS=new Set(['heartbeat','event'])"),
     ('apps/web/lib/runtime-isolation.js', "if(COLLECTOR_SOOP_KINDS.has(kind))return 'collector'"),
     ('apps/collector-runtime/api/login.js', "runtime:'collector'"),
     ('apps/collector-runtime/handlers/login.js', "if(operation==='soop-gateway')"))
link('web', 'public', '공개 조회 분기', 'HTTP / 권한',
     'data의 operation 허용 목록을 기준으로 공개 런타임을 고르고, 도착한 런타임도 허용 목록을 검사합니다.',
     ('apps/web/api/data.js', 'chooseRuntime:selectDataRuntime'),
     ('apps/web/lib/runtime-isolation.js', 'export function selectDataRuntime'),
     ('apps/public-runtime/api/data.js', "runtime:'public',allowRequest:allowPublicData"))
link('agent', 'edge', 'Agent 작업·풍벽지 요청', 'HTTP',
     'Agent가 agent-runtime-g3a Edge Function에 작업명을 전달합니다. 존재하는 모든 분기가 활성인 것은 아니며 서버의 operation 허용 목록도 확인해야 합니다.',
     ('apps/windows-agent/VNextDevelopmentClient.cs', '"/functions/v1/agent-runtime-g3a"'),
     ('supabase/functions/agent-runtime-g3a/functions/agent-runtime/index.ts', 'if (operation === "wallpaper")'))
link('edge', 'db', '풍벽지 스냅샷 RPC', 'RPC',
     'Edge가 호출하는 함수명과 SQL 정의가 대응합니다. SQL은 변경 이력이며 어느 정의가 현재 배포돼 있는지는 이 지도에서 확인하지 않습니다.',
     ('supabase/functions/agent-runtime-g3a/functions/agent-runtime/index.ts', '"rpc/g3a_get_wallpaper_snapshot_v1"'),
     ('supabase/migrations/20260903135337_wallpaper_layer_order.sql', 'create or replace function public.g3a_get_wallpaper_snapshot_v1'))
link('admin', 'db', '업보 수집 설정 저장', 'RPC',
     '관리 API의 RPC 호출과 SQL 함수 정의를 연결했습니다. 후속 마이그레이션의 함수 수정도 있으므로 최초 정의를 최신 운영본으로 해석하면 안 됩니다.',
     ('apps/admin-runtime/lib/upbo-collection.js', "sb('rpc/byeollog_upbo_collection_settings_v1'"),
     ('supabase/migrations/20261011054734_upbo_collection_settings.sql', 'create function public.byeollog_upbo_collection_settings_v1'),
     ('supabase/migrations/20261011080403_overlay_upbo_authority.sql', "pg_get_functiondef('public.byeollog_upbo_collection_settings_v1"))
link('collector', 'db', 'SOOP 이벤트 소유권 확인', 'RPC',
     '수집 API가 이벤트의 워크스페이스 소유권을 RPC로 확인합니다. 이벤트 저장·후속 처리는 별도 함수와 분기로 이어집니다.',
     ('apps/collector-runtime/lib/soop-gateway-api.js', "sbImpl('rpc/claim_soop_event_ownership_v1'"),
     ('supabase/migrations/20260906152929_enforce_soop_workspace_ownership.sql', 'create or replace function public.claim_soop_event_ownership_v1'))
link('public', 'db', '공개 조회 전용 RPC', 'RPC / 권한',
     '공개 조회는 fetchPublicRead를 통해 전용 RPC와 공개 조회 토큰을 사용합니다. 다른 런타임과 같은 권한의 프로세스로 합치지 않았습니다.',
     ('apps/public-runtime/handlers/data.js', '()=>fetchPublicRead(readConfig,operation,body)'),
     ('apps/public-runtime/lib/public-read.js', '/rest/v1/rpc/byeollog_public_read_v1'),
     ('supabase/migrations/20260920153935_public_read_least_privilege.sql', 'function public.byeollog_public_read_v1'))
link('admin', 'backup', '백업 워커 요청', 'HTTP / 설정',
     '관리 서비스가 허용된 백업 워커 URL로 요청하고 API 진입점은 전용 핸들러에 연결됩니다. 설정값·비밀키는 지도에 포함하지 않습니다.',
     ('apps/admin-runtime/lib/backup-service.js', 'BYEOLLOG_BACKUP_WORKER_URL'),
     ('apps/admin-runtime/lib/backup-service.js', 'await fetch(url'),
     ('apps/backup-worker/api/backup.js', 'backup-worker-handler.js'))
link('backup', 'db', '전용 백업 RPC', 'RPC / 권한',
     '백업 클라이언트는 전용 계정의 제한된 RPC를 사용합니다. 관리 API와 동일한 DB 권한으로 합치면 안 되는 경계입니다.',
     ('apps/backup-worker/lib/backup-worker-client.js', "client.rpc('byeollog_backup_worker_v1'"),
     ('supabase/migrations/20260920160527_isolated_backup_worker.sql', 'create function public.byeollog_backup_worker_v1'))
link('agent', 'db', '오버레이 수집 인계·결과 RPC', 'RPC / lease',
     'Agent와 서버 워커는 직접 서로 호출하는 대신 같은 RPC의 소유권·heartbeat·reserve·complete 계약을 사용합니다. 이름에 Trial이 남아 있어도 무조건 과거 실험으로 분류할 수 없습니다.',
     ('apps/windows-agent/WeflabTrialAgent.cs', '"/rest/v1/rpc/byeollog_weflab_trial_rpc_v1"'),
     ('apps/windows-agent/WeflabTrialAgent.cs', 'action = "heartbeat"'),
     ('supabase/migrations/20261007225033_weflab_shadow_trial.sql', 'create function public.byeollog_weflab_trial_rpc_v1'))
link('overlay', 'db', '서버 수집 인계·결과 RPC', 'RPC / lease',
     'production-server가 trial-server를 재사용합니다. 두 수집 위치의 보완 관계는 DB 계약으로 이어지며 직접 Agent↔서버 선을 만들지 않았습니다.',
     ('tools/weflab-lab/production-server.mjs', "import {runTrialServer}"),
     ('tools/weflab-lab/trial-server.mjs', "'/rest/v1/rpc/byeollog_weflab_trial_rpc_v1'"),
     ('supabase/migrations/20261007225033_weflab_shadow_trial.sql', 'create function public.byeollog_weflab_trial_rpc_v1'))
link('overlay', 'db', '자동 결과 게시 제어', 'RPC',
     '운영 진입점이 discover·publish를 별도 RPC로 호출합니다. 소스 경로에 lab이 있어도 운영 진입점에서 참조하므로 전체를 실험 폴더로 숨기지 않았습니다.',
     ('tools/weflab-lab/production-server.mjs', "'/rest/v1/rpc/byeollog_overlay_runtime_v1'"),
     ('tools/weflab-lab/production-server.mjs', "await rpc('publish')"),
     ('supabase/migrations/20261011080403_overlay_upbo_authority.sql', 'create function public.byeollog_overlay_runtime_v1'))
link('gateway', 'gateway', '직접 소켓 이벤트 → 전송 대기열', '이벤트 콜백',
     '직접 연결의 onEvent가 게이트웨이 콜백을 거쳐 durable outbox에 들어갑니다. 문자열·콜백·큐로 이어지는 관계를 한 구성요소 내부의 흐름으로 기록했습니다.',
     ('services/soop-gateway/services/soop-chat-gateway/direct/session.mjs', 'onEvent:e=>onEvent'),
     ('services/soop-gateway/services/soop-chat-gateway/index.mjs', 'onEvent:event=>'),
     ('services/soop-gateway/services/soop-chat-gateway/index.mjs', 'eventSequencer.run(workspaceId,()=>enqueueGatewayEvent'))
link('overlay', 'provider', '외부 알림 연결·결과 조회', '외부 / 호출 측만',
     '로컬 소스에서 소켓 연결과 결과 HTTP 요청을 확인했습니다. 외부 서버 구현·응답 및 실제 방송 화면과의 일치는 이 정적 분석으로 검증되지 않습니다. 조회는 실행하지 않았습니다.',
     ('tools/weflab-lab/trial-server.mjs', 'const ws=new WebSocket'),
     ('tools/weflab-lab/trial-server.mjs', "await fetchResult('https://weflab.com/api/'"))
link('agent', 'provider', 'PC의 외부 알림 연결·결과 조회', '외부 / 호출 측만',
     'Agent도 소유권을 얻었을 때 수집·조회합니다. 외부 서비스 응답 계약은 호출 측 근거만 있으며 실제 통신은 이번 작업에서 수행하지 않았습니다.',
     ('apps/windows-agent/WeflabTrialAgent.cs', 'using var ws = new ClientWebSocket()'),
     ('apps/windows-agent/WeflabTrialAgent.cs', 'if (status == "owner" && intake?.Ready == true)'))
link('gateway', 'provider', 'SOOP 직접 소켓 연결', '외부 / 호출 측만',
     '세션 어댑터가 rolling 연결 코어를 호출하고 코어가 플랫폼 방 주소로 WebSocket을 엽니다. 플랫폼 내부 구현이나 현재 연결 상태까지 확인한 것은 아닙니다.',
     ('services/soop-gateway/services/soop-chat-gateway/direct/session.mjs', 'await observeRolling(config'),
     ('services/soop-gateway/services/soop-chat-gateway/direct/core.mjs', "socket=new WebSocketImpl(room.url,'chat'"))

def category(p):
    s = p.lower()
    if not p: return '출처 미해결'
    if 'test' in s.split('/') or s.startswith(('tests/', 'test-support/')) or '/agentstoretests/' in s or re.search(r'\.(test|spec)\.', s): return '테스트'
    if s.endswith('.sql'): return 'SQL 변경·정의 이력'
    if s.startswith('docs/') or s.endswith('.md'): return '문서'
    if s in {'tools/weflab-lab/production-server.mjs', 'tools/weflab-lab/trial-server.mjs', 'tools/weflab-lab/protocol.mjs', 'tools/weflab-lab/browserless-core.mjs'}: return '서비스 소스'
    if s.startswith(('tools/', 'operations/')): return '도구·운영 설정'
    if s.endswith(('.json', '.yml', '.yaml', '.toml', '.csproj', '.props', '.targets', '.config', '.lock')): return '구성·빌드'
    if s.startswith(('apps/', 'services/', 'supabase/functions/')): return '서비스 소스'
    return '기타 검토 대상'

def component(p):
    for prefix, owner in [('apps/windows-agent/', 'agent'), ('apps/web/', 'web'), ('apps/admin-runtime/', 'admin'), ('apps/collector-runtime/', 'collector'), ('apps/public-runtime/', 'public'), ('apps/backup-worker/', 'backup'), ('services/soop-gateway/', 'gateway'), ('supabase/functions/', 'edge'), ('supabase/', 'db'), ('tools/weflab-lab/', 'overlay')]:
        if p.startswith(prefix): return owner
    return ''

def build():
    graph = json.loads((OUT / 'graph.json').read_text(encoding='utf-8'))
    nodes = {n['id']: n for n in graph['nodes']}
    raw_edges = graph.get('links', graph.get('edges', []))
    degree = Counter(); cross = Counter(); sources = defaultdict(list); groups = defaultdict(list)
    for n in nodes.values():
        sources[n.get('source_file', '')].append(n)
        groups[str(n.get('community', 'unknown'))].append(n)
    for e in raw_edges:
        degree[e['source']] += 1; degree[e['target']] += 1
        a, b = nodes[e['source']], nodes[e['target']]
        if a.get('community') != b.get('community'):
            cross[str(a.get('community'))] += 1; cross[str(b.get('community'))] += 1
    files = []
    for p, ns in sources.items():
        if not p: continue
        files.append(dict(path=p, category=category(p), component=component(p), nodes=len(ns), isolated=sum(degree[n['id']] == 0 for n in ns)))
    islands = []
    for group, ns in groups.items():
        if cross[group]: continue
        cats = Counter(category(n.get('source_file', '')) for n in ns)
        paths = sorted({n.get('source_file', '') for n in ns} - {''})
        islands.append(dict(id=group, label=ns[0].get('community_name') or ns[0]['label'], nodes=len(ns), category=cats.most_common(1)[0][0], categories=dict(cats), files=paths, missingSources=sum(not n.get('source_file') for n in ns)))

    # Literal-name matches are candidates, not verified call graphs or deployed schemas.
    tracked = git('ls-files', '-z').split('\0')
    definitions = defaultdict(list); calls = defaultdict(list)
    sql_re = re.compile(r'\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?([\w]+)"?\s*\.\s*)?"?([\w]+)"?\s*\(', re.I)
    call_re = re.compile(r'''(?:rpc/|\.rpc\(\s*['"])([a-zA-Z_][a-zA-Z0-9_]*)''')
    for p in tracked:
        if not p or not (ROOT/p).is_file(): continue
        if p.endswith('.sql'):
            content=(ROOT/p).read_text(encoding='utf-8-sig')
            for m in sql_re.finditer(content):
                definitions[m[2]].append(dict(file=p, line=content.count('\n', 0, m.start())+1, schema=m[1] or 'unspecified'))
        elif category(p)=='서비스 소스' and Path(p).suffix in {'.js','.mjs','.ts','.cs'}:
            content=(ROOT/p).read_text(encoding='utf-8-sig')
            for m in call_re.finditer(content):
                calls[m[1]].append(dict(file=p,line=content.count('\n',0,m.start())+1))
    rpc = [dict(name=k, calls=v, definitions=definitions.get(k, []), status='이름 일치 후보' if k in definitions else '정의 미확인') for k,v in sorted(calls.items())]
    data = dict(schemaVersion=1, sourceCommit=git('rev-parse','HEAD'), generatedAt=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
                scope='로컬 소스 분석 · 배포 및 실제 통신 미검증',
                rawGraphSha256=hashlib.sha256((OUT/'graph.json').read_bytes()).hexdigest(),
                stats=dict(nodes=len(nodes), edges=len(raw_edges), communities=len(groups), islands=len(islands), isolatedNodes=sum(degree[n]==0 for n in nodes), inferredEdges=sum(e.get('confidence')=='INFERRED' for e in raw_edges), files=len(files), sourceMissingNodes=len(sources.get('',[]))),
                components=[dict(id=i,title=t,description=d,col=x,row=y) for i,t,d,x,y in COMPONENTS],
                connections=edges, files=sorted(files,key=lambda x:x['path']), islands=sorted(islands,key=lambda x:(x['category'],x['id'])), rpcCandidates=rpc)
    OUT.mkdir(exist_ok=True)
    text=json.dumps(data,ensure_ascii=False,separators=(',',':'))
    (OUT/'architecture-evidence.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    template=(Path(__file__).parent/'template.html').read_text(encoding='utf-8')
    (OUT/'architecture.html').write_text(template.replace('__DATA__',text.replace('<','\\u003c')),encoding='utf-8')
    print(json.dumps(dict(connections=len(edges),evidence=sum(len(e['evidence']) for e in edges),files=len(files),islands=len(islands),rpcCandidates=len(rpc),matchedRpc=sum(bool(r['definitions']) for r in rpc),stats=data['stats']),ensure_ascii=False))

if __name__=='__main__': build()
