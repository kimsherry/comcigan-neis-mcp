import vm from 'node:vm';
import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';
import iconv from 'iconv-lite';

const COMCIGAN_HOST = 'http://xn--s39aj90b0nb2xw6xh.kr';
const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'] as const;

export interface ComciganSchool {
  region: string;
  name: string;
  code: number;
}

export interface TimetablePeriod {
  period: number;
  time: string | null;
  subject: string;
  teacher: string;
  changed: boolean;
}

export interface DailyTimetableResult {
  school: ComciganSchool;
  grade: number;
  classNum: number;
  date: string;
  weekday: string;
  classTimes: string[];
  periods: TimetablePeriod[];
  note?: string;
}

export interface WeeklyTimetableResult {
  school: ComciganSchool;
  grade: number;
  classNum: number;
  classTimes: string[];
  days: Record<string, TimetablePeriod[]>;
}

/**
 * 한국 표준시(KST) 기준 YYYY-MM-DD 날짜 문자열과 요일 인덱스(0=일..6=토)를 계산합니다.
 */
export function resolveKstDate(dateInput?: string): {
  dateStr: string;
  dayOfWeek: number;
  weekdayName: string;
} {
  const now = new Date();
  let targetDate: Date;

  if (!dateInput || dateInput.toLowerCase() === 'today') {
    const kstStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
    }).format(now);
    targetDate = new Date(`${kstStr}T00:00:00+09:00`);
  } else if (dateInput.toLowerCase() === 'tomorrow') {
    const kstStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
    }).format(now);
    targetDate = new Date(`${kstStr}T00:00:00+09:00`);
    targetDate.setDate(targetDate.getDate() + 1);
  } else {
    const normalized = dateInput.replace(/\./g, '-').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new Error(
        `날짜 형식이 올바르지 않습니다: "${dateInput}". YYYY-MM-DD, "today", 또는 "tomorrow"를 사용하세요.`,
      );
    }
    targetDate = new Date(`${normalized}T00:00:00+09:00`);
    if (Number.isNaN(targetDate.getTime())) {
      throw new Error(`유효하지 않은 날짜입니다: "${dateInput}"`);
    }
  }

  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
  }).format(targetDate);

  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
  }).format(targetDate);

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dayMap[weekdayShort] ?? targetDate.getDay();

  return {
    dateStr,
    dayOfWeek,
    weekdayName: WEEKDAY_NAMES[dayOfWeek],
  };
}

interface AjaxRequestOptions {
  url: string;
  method?: string;
  contentType?: string;
  data?: string;
  headers?: Record<string, string>;
  success?: (responseText: string) => void;
}

interface ComciganRuntime {
  pageUrl: string;
  token: string;
  cookies: string;
  context: vm.Context;
  renderFuncName: string;
  loadFuncName: string;
  loadPrefix: string;
  pendingFetches: Promise<void>[];
  lastError: string | null;
  domHtml: Record<string, string>;
}

let cachedRuntime: ComciganRuntime | null = null;
let runtimeLoadedAt = 0;
const RUNTIME_TTL_MS = 1000 * 60 * 10; // 10분

interface CachedSchoolData {
  data: Record<string, unknown>;
  fetchedAt: number;
}
const schoolDataCache = new Map<number, CachedSchoolData>();
const SCHOOL_CACHE_TTL_MS = 1000 * 60 * 5; // 5분

function decodeObfuscatedScripts(rawScript: string): string[] {
  const outputs: string[] = [];
  function runAndCapture(code: string) {
    const wrapped = code.replace(
      /\(0\s*,\s*eval\)\s*\(\s*s\s*\)/g,
      '(__capture(s))',
    );
    vm.runInNewContext(wrapped, {
      __capture: (s: string) => {
        outputs.push(s);
        if (s.includes('(0,eval)(s)') || s.includes('(0, eval)(s)')) {
          runAndCapture(s);
        }
      },
      window: {},
      document: { ajaxError: () => {} },
      $: () => ({ ajaxError: () => {} }),
      jQuery: {},
      CryptoJS,
    });
  }
  runAndCapture(rawScript);
  return outputs;
}

async function initRuntime(forceRefresh = false): Promise<ComciganRuntime> {
  const now = Date.now();
  if (!forceRefresh && cachedRuntime && now - runtimeLoadedAt < RUNTIME_TTL_MS) {
    return cachedRuntime;
  }

  const hostRes = await fetch(COMCIGAN_HOST);
  if (!hostRes.ok) {
    throw new Error(`컴시간학생.kr 접속 실패: HTTP ${hostRes.status}`);
  }
  const hostHtml = await hostRes.text();
  const frameMatch = hostHtml.match(/<frame[^>]*src=["']([^"']+)["']/i);
  if (!frameMatch) {
    throw new Error('컴시간학생.kr에서 프레임 주소를 찾을 수 없습니다.');
  }

  const pageUrl = new URL(frameMatch[1], COMCIGAN_HOST).toString();
  const pageRes = await fetch(pageUrl);
  if (!pageRes.ok) {
    throw new Error(`컴시간 시간표 페이지 접속 실패: HTTP ${pageRes.status}`);
  }

  const cookies = pageRes.headers.getSetCookie?.()?.map((c) => c.split(';')[0]).join('; ') || '';
  const buf = Buffer.from(await pageRes.arrayBuffer());
  const html = iconv.decode(buf, 'EUC-KR');

  const tokenMatch = html.match(/window\.__HourRequestToken\s*=\s*['"]([^'"]+)['"]/);
  const token = tokenMatch?.[1] ?? '';

  const scriptTags = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const decodedParts: string[] = [];

  for (const tag of scriptTags) {
    const body = tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    if (body.includes('(0,eval)(s)') || body.includes('(0, eval)(s)')) {
      decodedParts.push(...decodeObfuscatedScripts(body));
    }
  }

  const fullCode = decodedParts.join('\n');
  if (!fullCode) {
    throw new Error('컴시간 스크립트를 디코딩하지 못했습니다.');
  }

  const renderMatch = fullCode.match(
    /function\s+([A-Za-z0-9_$]+)\s*\(\s*자료\s*,\s*학년\s*,\s*반\s*\)/,
  );
  if (!renderMatch) {
    throw new Error('시간표 렌더링 함수를 찾을 수 없습니다.');
  }

  const loadCallMatch = fullCode.match(
    /([A-Za-z0-9_$]+)\(\s*['"]([0-9]+_)['"]\s*,\s*storage\.sc/,
  );
  if (!loadCallMatch) {
    throw new Error('시간표 조회 함수 시그니처를 찾을 수 없습니다.');
  }

  const runtime: ComciganRuntime = {
    pageUrl,
    token,
    cookies,
    context: {} as vm.Context,
    renderFuncName: renderMatch[1],
    loadFuncName: loadCallMatch[1],
    loadPrefix: loadCallMatch[2],
    pendingFetches: [],
    lastError: null,
    domHtml: {},
  };

  const mockJqueryFn = (selector?: unknown) => {
    const key = typeof selector === 'string' ? selector : '__default';
    const chain = {
      empty: () => {
        runtime.domHtml[key] = '';
        return chain;
      },
      append: (content: unknown) => {
        runtime.domHtml[key] = (runtime.domHtml[key] ?? '') + String(content ?? '');
        return chain;
      },
      hide: () => chain,
      show: () => chain,
      val: () => '',
      text: (content?: unknown) => {
        if (content !== undefined) {
          runtime.domHtml[key] = String(content);
          return chain;
        }
        return runtime.domHtml[key] ?? '';
      },
      html: () => runtime.domHtml[key] ?? '',
      attr: () => '',
      prop: () => chain,
      css: () => chain,
      on: () => chain,
      change: () => chain,
      ajaxError: () => chain,
    };
    return chain;
  };

  mockJqueryFn.ajax = (opts: AjaxRequestOptions) => {
    const targetUrl = new URL(opts.url, pageUrl).toString();
    const p = (async () => {
      const headers: Record<string, string> = {
        ...(opts.headers ?? {}),
      };
      if (opts.contentType) {
        headers['Content-Type'] = opts.contentType;
      }
      if (cookies) {
        headers['Cookie'] = cookies;
      }
      headers['Referer'] = pageUrl;

      const res = await fetch(targetUrl, {
        method: opts.method || 'GET',
        headers,
        body: opts.method?.toUpperCase() === 'POST' ? opts.data : undefined,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`컴시간 API 오류 (HTTP ${res.status}): ${text}`);
      }
      if (opts.success) {
        opts.success(text);
      }
    })();
    runtime.pendingFetches.push(p);
  };

  const dummyStorage: Record<string, string> = {
    r2: '0',
    scnm: '',
    sc: '',
    hour: '{}',
    ba: '1-1',
  };

  const sandbox: Record<string, unknown> = {
    window: {
      __HourRequestToken: token,
      localStorage: dummyStorage,
      isNaN: Number.isNaN,
      confirm: () => false,
      alert: (msg: string) => {
        runtime.lastError = String(msg);
      },
      setTimeout,
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => ({ value: '1-1' }),
    },
    storage: dummyStorage,
    H학교명단: {},
    Yf37: {},
    $: mockJqueryFn,
    jQuery: mockJqueryFn,
    CryptoJS,
    TextDecoder,
    TextEncoder,
    btoa: (str: string) => Buffer.from(str, 'binary').toString('base64'),
    atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
    encodeURIComponent,
    decodeURIComponent,
    alert: (msg: string) => {
      runtime.lastError = String(msg);
    },
    학교명단_출력하기: () => {},
    시간표_출력하기: () => {},
    학급설정하기: () => '',
    일자설정하기: () => '',
    요일출력하기: () => '',
    sc_search: () => {},
    setTimeout,
    console,
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;

  const ctx = vm.createContext(sandbox);
  runtime.context = ctx;

  // ajaxError 핸들러 블록과 실제 API/파싱 함수들만 실행 (초기 DOM 부트스트랩 제외)
  for (const part of decodedParts) {
    if (part.includes("storage.sc==''")) continue;
    vm.runInContext(part, ctx);
  }
  // 브라우저 DOM 렌더링 부수효과 함수는 무효화 (데이터 파싱만 수행)
  vm.runInContext(
    'if (typeof 화면구성하기 === "function") 화면구성하기 = function() {}; if (typeof 시간표_출력하기 === "function") 시간표_출력하기 = function() {};',
    ctx,
  );

  cachedRuntime = runtime;
  runtimeLoadedAt = now;
  return runtime;
}

async function flushPending(runtime: ComciganRuntime) {
  const tasks = runtime.pendingFetches.splice(0, runtime.pendingFetches.length);
  await Promise.all(tasks);
  if (runtime.lastError) {
    const err = runtime.lastError;
    runtime.lastError = null;
    throw new Error(`컴시간 응답 오류: ${err}`);
  }
}

async function runSchoolSearch(
  runtime: ComciganRuntime,
  keyword: string,
): Promise<ComciganSchool[]> {
  runtime.lastError = null;
  runtime.domHtml['#학교명단검색'] = '';

  vm.runInContext(`school_ra(${JSON.stringify(keyword)})`, runtime.context);
  await flushPending(runtime);

  const html = runtime.domHtml['#학교명단검색'] ?? '';
  if (!html) return [];

  const $ = cheerio.load(`<table>${html}</table>`);
  const schools: ComciganSchool[] = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const region = $(tds[0]).text().trim();
    const link = $(tds[1]).find('a');
    if (link.length === 0) return;

    const name = link.text().trim();
    const onClick = link.attr('onclick') || link.attr('onClick') || '';
    const codeMatch = onClick.match(/sc_disp\(\s*(\d+)\s*\)/);
    if (codeMatch) {
      schools.push({
        region,
        name,
        code: Number(codeMatch[1]),
      });
    }
  });

  return schools;
}

export async function searchComciganSchools(
  keyword: string,
): Promise<ComciganSchool[]> {
  const runtime = await initRuntime();
  let schools = await runSchoolSearch(runtime, keyword);

  // "서울고등학교" 등으로 검색이 안 될 때 "서울고" 등으로 자동 재검색
  if (schools.length === 0) {
    const shortened = keyword.replace(/(고등학교|중학교|초등학교)$/, (m) => m[0]);
    if (shortened !== keyword && shortened.length >= 2) {
      schools = await runSchoolSearch(runtime, shortened);
    }
  }

  if (schools.length === 0) {
    throw new Error(`컴시간에서 "${keyword}" 학교를 찾을 수 없습니다.`);
  }

  return schools;
}

async function resolveSchool(
  schoolNameOrCode: string | number,
  regionHint?: string,
): Promise<ComciganSchool> {
  if (
    typeof schoolNameOrCode === 'number' ||
    /^\d+$/.test(String(schoolNameOrCode).trim())
  ) {
    const code = Number(schoolNameOrCode);
    return { region: '', name: `학교코드(${code})`, code };
  }

  const results = await searchComciganSchools(String(schoolNameOrCode).trim());
  if (regionHint) {
    const filtered = results.filter((s) => s.region.includes(regionHint));
    if (filtered.length > 0) return filtered[0];
  }
  return results[0];
}

async function loadSchoolTimetableData(
  runtime: ComciganRuntime,
  schoolCode: number,
  weekIndex = 1,
): Promise<Record<string, unknown>> {
  const cached = schoolDataCache.get(schoolCode);
  if (cached && Date.now() - cached.fetchedAt < SCHOOL_CACHE_TTL_MS && weekIndex === 1) {
    vm.runInContext('Yf37 = __cachedData', Object.assign(runtime.context, { __cachedData: cached.data }));
    return cached.data;
  }

  runtime.lastError = null;
  const callCode = `${runtime.loadFuncName}(${JSON.stringify(runtime.loadPrefix)}, ${schoolCode}, ${weekIndex}, '1')`;
  vm.runInContext(callCode, runtime.context);
  await flushPending(runtime);

  const data = vm.runInContext('Yf37', runtime.context) as Record<string, unknown>;
  if (!data || typeof data !== 'object') {
    throw new Error('시간표 데이터를 불러오지 못했습니다.');
  }

  if (weekIndex === 1) {
    schoolDataCache.set(schoolCode, { data, fetchedAt: Date.now() });
  }
  return data;
}

function parseTimetableHtml(
  tableHtml: string,
  classTimes: string[],
): Record<number, TimetablePeriod[]> {
  const $ = cheerio.load(tableHtml);
  const byWeekday: Record<number, TimetablePeriod[]> = {
    0: [],
    1: [],
    2: [],
    3: [],
    4: [],
  };

  $('tr').each((rowIdx, tr) => {
    if (rowIdx <= 1) return; // 0: 제목, 1: 요일 헤더
    const periodNum = rowIdx - 1;

    $(tr)
      .find('td')
      .each((colIdx, td) => {
        if (colIdx === 0 || colIdx > 5) return; // 0: 교시, 1~5: 월~금
        const weekdayIdx = colIdx - 1;
        const $td = $(td);
        const changed = $td.hasClass('변경');

        // <td>과목<br>교사</td> 형태 파싱
        const htmlContent = ($td.html() || '').trim();
        const parts = htmlContent
          .split(/<br\s*\/?>/i)
          .map((part) => cheerio.load(part).text().trim())
          .filter(Boolean);

        const subject = parts[0] ?? '';
        const teacher = parts[1] ?? '';

        if (subject || teacher) {
          byWeekday[weekdayIdx].push({
            period: periodNum,
            time: classTimes[periodNum - 1] ?? null,
            subject,
            teacher,
            changed,
          });
        }
      });
  });

  return byWeekday;
}

export async function getDailyTimetable(params: {
  school: string | number;
  grade: number;
  classNum: number;
  date?: string;
  regionHint?: string;
}): Promise<DailyTimetableResult> {
  const { dateStr, dayOfWeek, weekdayName } = resolveKstDate(params.date);
  const runtime = await initRuntime();
  const school = await resolveSchool(params.school, params.regionHint);
  const data = await loadSchoolTimetableData(runtime, school.code, 1);

  const classTimes = Array.isArray(data['일과시간'])
    ? (data['일과시간'] as string[])
    : [];

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      school,
      grade: params.grade,
      classNum: params.classNum,
      date: dateStr,
      weekday: weekdayName,
      classTimes,
      periods: [],
      note: `${weekdayName}요일(주말)에는 정규 수업 시간표가 없습니다.`,
    };
  }

  const tableHtml = vm.runInContext(
    `${runtime.renderFuncName}(Yf37, ${params.grade}, ${params.classNum})`,
    runtime.context,
  ) as string;

  const parsed = parseTimetableHtml(tableHtml, classTimes);
  const periods = parsed[dayOfWeek - 1] ?? [];

  return {
    school,
    grade: params.grade,
    classNum: params.classNum,
    date: dateStr,
    weekday: weekdayName,
    classTimes,
    periods,
  };
}

export async function getWeeklyTimetable(params: {
  school: string | number;
  grade: number;
  classNum: number;
  regionHint?: string;
}): Promise<WeeklyTimetableResult> {
  const runtime = await initRuntime();
  const school = await resolveSchool(params.school, params.regionHint);
  const data = await loadSchoolTimetableData(runtime, school.code, 1);

  const classTimes = Array.isArray(data['일과시간'])
    ? (data['일과시간'] as string[])
    : [];

  const tableHtml = vm.runInContext(
    `${runtime.renderFuncName}(Yf37, ${params.grade}, ${params.classNum})`,
    runtime.context,
  ) as string;

  const parsed = parseTimetableHtml(tableHtml, classTimes);
  const labels = ['월', '화', '수', '목', '금'];
  const days: Record<string, TimetablePeriod[]> = {};
  for (let i = 0; i < 5; i++) {
    days[labels[i]] = parsed[i] ?? [];
  }

  return {
    school,
    grade: params.grade,
    classNum: params.classNum,
    classTimes,
    days,
  };
}
