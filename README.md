# comcigan-neis-mcp

한국 초·중·고등학교 시간표(**컴시간학생.kr**)와 학사일정(**나이스 NEIS Open API**)을 조회할 수 있는 **Model Context Protocol (MCP)** 서버입니다.

로컬 AI 클라이언트용 **`stdio`** 모드와 원격 접속용 **`Streamable HTTP`** 모드를 모두 지원합니다.

## 주요 기능 (MCP Tools)

| Tool 이름 | 설명 |
|---|---|
| `search_school` | 학교 이름으로 컴시간 학교 코드와 NEIS 학교 정보(교육청코드, 표준학교코드)를 동시 검색 |
| `get_timetable` | 원하는 학년/반 및 날짜(`YYYY-MM-DD`, `today`, `tomorrow`, `week`)의 시간표와 변동 여부 조회 |
| `get_academic_schedule` | NEIS Open API로 지정 기간(생략 시 이번 달)의 학사일정 조회 |
| `get_daily_briefing` | 특정 날짜의 시간표와 학사일정을 한 번에 조회 |

---

## 설치 및 빌드

```bash
npm install
npm run build
```

## 환경변수 설정

`.env.example`을 참고해 필요한 환경변수를 설정할 수 있습니다. (모두 선택 사항입니다.)

| 변수명 | 설명 | 기본값 |
|---|---|---|
| `DEFAULT_SCHOOL` | 기본 학교명 (설정 시 질문마다 학교명을 입력하지 않아도 됨) | - |
| `DEFAULT_GRADE` | 기본 학년 | - |
| `DEFAULT_CLASS` | 기본 반 | - |
| `NEIS_API_KEY` | [나이스 교육정보 개방 포털](https://open.neis.go.kr) 무료 API 키 | - |
| `PORT` | HTTP 모드 실행 시 포트 | `3000` |
| `HOST` | HTTP 모드 바인딩 주소 | `0.0.0.0` |
| `MCP_AUTH_TOKEN` | HTTP 모드 Bearer 인증 토큰 (외부 공개 시 설정 권장) | - |
| `MCP_PATH` | 커스텀 엔드포인트 비밀 경로 (예: `/mcp/secret-key`) | `/mcp` |
| `MCP_CORS_ORIGIN` | CORS 허용 출처 (미설정 시 교차 출처 차단) | - |
| `RATE_LIMIT_MAX` | IP당 분당 최대 요청 횟수 | `60` |

---

## 실행 방법

### 1. 로컬 `stdio` 모드 (Cursor, Claude Desktop, Antigravity 등)

클라이언트의 MCP 설정 파일(`mcp_config.json` 등)에 아래처럼 등록하세요.

```json
{
  "mcpServers": {
    "school-timetable": {
      "command": "node",
      "args": ["/path/to/comcigan-neis-mcp/dist/index.js"],
      "env": {
        "DEFAULT_SCHOOL": "서울고등학교",
        "DEFAULT_GRADE": "1",
        "DEFAULT_CLASS": "1",
        "NEIS_API_KEY": ""
      }
    }
  }
}
```

### 2. 원격 `Streamable HTTP` 모드

```bash
npm run start:http
```

- MCP 엔드포인트: `http://<HOST>:<PORT>/mcp`
- 헬스체크: `GET http://<HOST>:<PORT>/health`

#### Docker Compose로 실행

```bash
cp .env.example .env
# .env 파일을 원하는 값으로 수정 후
docker compose up -d --build
```

#### Gemini CLI 연결 예시

```bash
gemini mcp add --transport http school-timetable http://localhost:3000/mcp
```

---

## 주의사항
- `컴시간학생.kr`은 공식 Open API를 제공하지 않으며, 비공식 파싱 특성상 웹사이트 구조 변경 시 동작에 영향을 받을 수 있습니다. 개인 학습 및 편의 목적으로만 사용하세요.
- 학사일정 조회는 교육부·KERIS 나이스(NEIS) 교육정보 개방 포털 Open API를 사용합니다.

## License
MIT
