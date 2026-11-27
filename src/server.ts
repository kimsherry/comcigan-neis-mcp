import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getDailyTimetable,
  getWeeklyTimetable,
  resolveKstDate,
  searchComciganSchools,
} from './services/comcigan.js';
import { getAcademicSchedule, searchNeisSchools } from './services/neis.js';

function getDefaultSchool(input?: string): string {
  const school = input?.trim() || process.env.DEFAULT_SCHOOL?.trim();
  if (!school) {
    throw new Error(
      '학교명이 필요합니다. school 파라미터를 전달하거나 DEFAULT_SCHOOL 환경변수를 설정하세요.',
    );
  }
  return school;
}

function getDefaultGrade(input?: number): number {
  const grade =
    input ??
    (process.env.DEFAULT_GRADE ? Number(process.env.DEFAULT_GRADE) : undefined);
  if (!grade || Number.isNaN(grade)) {
    throw new Error(
      '학년이 필요합니다. grade 파라미터를 전달하거나 DEFAULT_GRADE 환경변수를 설정하세요.',
    );
  }
  return grade;
}

function getDefaultClass(input?: number): number {
  const classNum =
    input ??
    (process.env.DEFAULT_CLASS ? Number(process.env.DEFAULT_CLASS) : undefined);
  if (!classNum || Number.isNaN(classNum)) {
    throw new Error(
      '반이 필요합니다. class_num 파라미터를 전달하거나 DEFAULT_CLASS 환경변수를 설정하세요.',
    );
  }
  return classNum;
}

function getMonthRangeFromDate(dateStr: string): {
  startDate: string;
  endDate: string;
} {
  const [yearStr, monthStr] = dateStr.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${yearStr}-${monthStr}-01`,
    endDate: `${yearStr}-${monthStr}-${String(lastDay).padStart(2, '0')}`,
  };
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `오류: ${message}`,
      },
    ],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'comcigan-neis-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'search_school',
    {
      description:
        '학교 이름으로 컴시간(시간표) 학교 코드와 나이스(NEIS) 학교 정보를 함께 검색합니다.',
      inputSchema: {
        school_name: z
          .string()
          .min(1)
          .describe('검색할 학교 이름 (예: 서울고등학교)'),
        region_hint: z
          .string()
          .optional()
          .describe('동명이인 학교가 많을 때 지역 필터 (예: 서울, 경기)'),
      },
    },
    async ({ school_name, region_hint }) => {
      try {
        const [comcigan, neis] = await Promise.allSettled([
          searchComciganSchools(school_name),
          searchNeisSchools(school_name, region_hint),
        ]);

        return textResult({
          query: school_name,
          comcigan:
            comcigan.status === 'fulfilled'
              ? comcigan.value
              : {
                  error:
                    comcigan.reason instanceof Error
                      ? comcigan.reason.message
                      : String(comcigan.reason),
                },
          neis:
            neis.status === 'fulfilled'
              ? neis.value
              : {
                  error:
                    neis.reason instanceof Error
                      ? neis.reason.message
                      : String(neis.reason),
                },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_timetable',
    {
      description:
        '컴시간학생.kr에서 원하는 학년/반과 날짜(또는 이번 주 전체)의 시간표를 조회합니다.',
      inputSchema: {
        school: z
          .string()
          .optional()
          .describe(
            '학교 이름 또는 컴시간 학교 코드 (생략 시 DEFAULT_SCHOOL 사용)',
          ),
        grade: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('학년 (생략 시 DEFAULT_GRADE 사용)'),
        class_num: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('반 번호 (생략 시 DEFAULT_CLASS 사용)'),
        date: z
          .string()
          .optional()
          .describe(
            '조회할 날짜 (YYYY-MM-DD, "today", "tomorrow", 또는 "week"로 주간 전체 조회. 기본값: today)',
          ),
        region_hint: z.string().optional().describe('동명이교 구분용 지역명'),
      },
    },
    async ({ school, grade, class_num, date, region_hint }) => {
      try {
        const resolvedSchool = getDefaultSchool(school);
        const resolvedGrade = getDefaultGrade(grade);
        const resolvedClass = getDefaultClass(class_num);

        if (date?.toLowerCase() === 'week') {
          const weekly = await getWeeklyTimetable({
            school: resolvedSchool,
            grade: resolvedGrade,
            classNum: resolvedClass,
            regionHint: region_hint,
          });
          return textResult(weekly);
        }

        const daily = await getDailyTimetable({
          school: resolvedSchool,
          grade: resolvedGrade,
          classNum: resolvedClass,
          date: date ?? 'today',
          regionHint: region_hint,
        });
        return textResult(daily);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_academic_schedule',
    {
      description:
        '나이스(NEIS) Open API를 이용해 원하는 학교와 기간의 학사일정(행사, 시험, 방학, 공휴일 등)을 조회합니다.',
      inputSchema: {
        school: z
          .string()
          .optional()
          .describe('학교 이름 (생략 시 DEFAULT_SCHOOL 사용)'),
        start_date: z
          .string()
          .optional()
          .describe('조회 시작일 (YYYY-MM-DD). 생략 시 이번 달 1일'),
        end_date: z
          .string()
          .optional()
          .describe('조회 종료일 (YYYY-MM-DD). 생략 시 이번 달 말일'),
        grade: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('특정 학년 대상 일정만 필터링할 때 입력'),
        region_hint: z.string().optional().describe('동명이교 구분용 지역명'),
      },
    },
    async ({ school, start_date, end_date, grade, region_hint }) => {
      try {
        const resolvedSchool = getDefaultSchool(school);
        const today = resolveKstDate('today').dateStr;
        const monthRange = getMonthRangeFromDate(today);

        const startDate = start_date
          ? resolveKstDate(start_date).dateStr
          : monthRange.startDate;
        const endDate = end_date
          ? resolveKstDate(end_date).dateStr
          : monthRange.endDate;

        const schedule = await getAcademicSchedule({
          schoolName: resolvedSchool,
          startDate,
          endDate,
          grade,
          regionHint: region_hint,
        });

        return textResult(schedule);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_daily_briefing',
    {
      description:
        '원하는 날짜의 학년/반 시간표(컴시간)와 해당 날짜의 학사일정(NEIS)을 한 번에 조회합니다.',
      inputSchema: {
        school: z
          .string()
          .optional()
          .describe('학교 이름 (생략 시 DEFAULT_SCHOOL 사용)'),
        grade: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('학년 (생략 시 DEFAULT_GRADE 사용)'),
        class_num: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('반 번호 (생략 시 DEFAULT_CLASS 사용)'),
        date: z
          .string()
          .optional()
          .describe(
            '조회할 날짜 (YYYY-MM-DD, "today", "tomorrow". 기본값: today)',
          ),
        region_hint: z.string().optional().describe('동명이교 구분용 지역명'),
      },
    },
    async ({ school, grade, class_num, date, region_hint }) => {
      try {
        const resolvedSchool = getDefaultSchool(school);
        const resolvedGrade = getDefaultGrade(grade);
        const resolvedClass = getDefaultClass(class_num);
        const { dateStr } = resolveKstDate(date ?? 'today');

        const [timetableRes, scheduleRes] = await Promise.allSettled([
          getDailyTimetable({
            school: resolvedSchool,
            grade: resolvedGrade,
            classNum: resolvedClass,
            date: dateStr,
            regionHint: region_hint,
          }),
          getAcademicSchedule({
            schoolName: resolvedSchool,
            startDate: dateStr,
            endDate: dateStr,
            grade: resolvedGrade,
            regionHint: region_hint,
          }),
        ]);

        return textResult({
          date: dateStr,
          school: resolvedSchool,
          grade: resolvedGrade,
          classNum: resolvedClass,
          timetable:
            timetableRes.status === 'fulfilled'
              ? timetableRes.value
              : {
                  error:
                    timetableRes.reason instanceof Error
                      ? timetableRes.reason.message
                      : String(timetableRes.reason),
                },
          academicSchedule:
            scheduleRes.status === 'fulfilled'
              ? scheduleRes.value.events
              : {
                  error:
                    scheduleRes.reason instanceof Error
                      ? scheduleRes.reason.message
                      : String(scheduleRes.reason),
                },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
