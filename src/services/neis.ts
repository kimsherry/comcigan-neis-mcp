const NEIS_BASE_URL = 'https://open.neis.go.kr/hub';

export interface NeisSchoolInfo {
  ATPT_OFCDC_SC_CODE: string; // 시도교육청코드
  ATPT_OFCDC_SC_NM: string; // 시도교육청명
  SD_SCHUL_CODE: string; // 표준학교코드
  SCHUL_NM: string; // 학교명
  SCHUL_KND_SC_NM: string; // 학교종류명 (초등학교/중학교/고등학교 등)
  ORG_RDNMA: string; // 도로명주소
}

export interface NeisScheduleItem {
  AA_YMD: string; // 학사일자 (YYYYMMDD)
  EVENT_NM: string; // 행사명
  EVENT_CNTNT?: string; // 행사내용
  SBTR_DD_SC_NM?: string; // 수업공제일명 (휴업일, 공휴일 등)
  ONE_GRADE_EVENT_YN?: string;
  TW_GRADE_EVENT_YN?: string;
  THREE_GRADE_EVENT_YN?: string;
  FR_GRADE_EVENT_YN?: string;
  FIV_GRADE_EVENT_YN?: string;
  SIX_GRADE_EVENT_YN?: string;
}

interface NeisApiError {
  RESULT?: {
    CODE: string;
    MESSAGE: string;
  };
}

function getApiKey(): string | undefined {
  return process.env.NEIS_API_KEY?.trim() || undefined;
}

async function fetchNeis<T>(
  endpoint: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${NEIS_BASE_URL}/${endpoint}`);
  url.searchParams.set('Type', 'json');
  url.searchParams.set('pIndex', '1');
  url.searchParams.set('pSize', '100');

  const apiKey = getApiKey();
  if (apiKey) {
    url.searchParams.set('KEY', apiKey);
  }

  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`NEIS API HTTP 오류: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown> & NeisApiError;

  if (data.RESULT) {
    // INFO-200: 해당하는 데이터가 없습니다.
    if (data.RESULT.CODE === 'INFO-200') {
      return [];
    }
    throw new Error(`NEIS API 오류 (${data.RESULT.CODE}): ${data.RESULT.MESSAGE}`);
  }

  const section = data[endpoint] as
    | Array<{ head?: unknown; row?: T[] }>
    | undefined;
  if (!section || !Array.isArray(section)) {
    return [];
  }

  const rowBlock = section.find((item) => Array.isArray(item.row));
  return rowBlock?.row ?? [];
}

export async function searchNeisSchools(
  schoolName: string,
  regionHint?: string,
): Promise<NeisSchoolInfo[]> {
  const rows = await fetchNeis<NeisSchoolInfo>('schoolInfo', {
    SCHUL_NM: schoolName,
  });

  if (regionHint) {
    const filtered = rows.filter(
      (r) =>
        r.ATPT_OFCDC_SC_NM.includes(regionHint) ||
        r.ORG_RDNMA.includes(regionHint),
    );
    if (filtered.length > 0) return filtered;
  }

  return rows;
}

export async function getAcademicSchedule(params: {
  schoolName: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  grade?: number;
  regionHint?: string;
}): Promise<{
  school: NeisSchoolInfo;
  startDate: string;
  endDate: string;
  events: Array<{
    date: string;
    eventName: string;
    eventContent: string | null;
    dayType: string | null;
    targetGrades: number[];
  }>;
  usingApiKey: boolean;
}> {
  const schools = await searchNeisSchools(params.schoolName, params.regionHint);
  if (schools.length === 0) {
    throw new Error(
      `NEIS에서 학교를 찾을 수 없습니다: "${params.schoolName}"`,
    );
  }

  const school = schools[0];
  const fromYmd = params.startDate.replace(/-/g, '');
  const toYmd = params.endDate.replace(/-/g, '');

  const rows = await fetchNeis<NeisScheduleItem>('SchoolSchedule', {
    ATPT_OFCDC_SC_CODE: school.ATPT_OFCDC_SC_CODE,
    SD_SCHUL_CODE: school.SD_SCHUL_CODE,
    AA_FROM_YMD: fromYmd,
    AA_TO_YMD: toYmd,
  });

  const mapped = rows
    .map((r) => {
      const targetGrades: number[] = [];
      if (r.ONE_GRADE_EVENT_YN === 'Y') targetGrades.push(1);
      if (r.TW_GRADE_EVENT_YN === 'Y') targetGrades.push(2);
      if (r.THREE_GRADE_EVENT_YN === 'Y') targetGrades.push(3);
      if (r.FR_GRADE_EVENT_YN === 'Y') targetGrades.push(4);
      if (r.FIV_GRADE_EVENT_YN === 'Y') targetGrades.push(5);
      if (r.SIX_GRADE_EVENT_YN === 'Y') targetGrades.push(6);

      const ymd = r.AA_YMD;
      const formattedDate =
        ymd.length === 8
          ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
          : ymd;

      return {
        date: formattedDate,
        eventName: r.EVENT_NM,
        eventContent: r.EVENT_CNTNT?.trim() || null,
        dayType: r.SBTR_DD_SC_NM?.trim() || null,
        targetGrades,
      };
    })
    .filter((ev) => {
      if (!params.grade) return true;
      // targetGrades가 비어 있으면 전교생 대상으로 간주
      return ev.targetGrades.length === 0 || ev.targetGrades.includes(params.grade);
    });

  return {
    school,
    startDate: params.startDate,
    endDate: params.endDate,
    events: mapped,
    usingApiKey: Boolean(getApiKey()),
  };
}
