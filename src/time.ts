/**
 * 时间工具:把工具参数里的「某个时刻」按 World 配置的时区算成 epoch 毫秒,以及按该时区显示时间。
 * 全部按墙钟计算,不依赖运行进程的 TZ。
 */

export interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

/** 某个时刻在该时区的墙钟读数。 */
function wallClock(ms: number, tz: string): WallClock {
  const parts = partsFmt(tz).formatToParts(new Date(ms));
  const pick = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const h = pick('hour');
  return {
    y: pick('year'),
    m: pick('month'),
    d: pick('day'),
    h: h === 24 ? 0 : h,
    mi: pick('minute'),
    s: pick('second'),
  };
}

/** 该时刻的时区偏移(毫秒,东区为正)。 */
function tzOffsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  const msSec = Math.floor(ms / 1000) * 1000;
  return asUtc - msSec;
}

/** 该时区的墙钟 → epoch 毫秒(跨夏令时再校一次)。 */
function wallToEpoch(y: number, m: number, d: number, h = 0, mi = 0, s = 0, tz = 'UTC'): number {
  const wallAsUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const first = tzOffsetMs(wallAsUtc, tz);
  let epoch = wallAsUtc - first;
  const second = tzOffsetMs(epoch, tz);
  if (second !== first) epoch = wallAsUtc - second;
  return epoch;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function fmtDate(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

export function fmtTime(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

export function fmtDateTime(ms: number, tz: string): string {
  return `${fmtDate(ms, tz)} ${fmtTime(ms, tz)}`;
}

const DATE_ONLY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;
/** 相对写法:7d / 12h / 2w。「m」故意不收——月和分钟会打架。 */
const RELATIVE = /^(\d{1,4})\s*(h|d|w)$/i;

const HOUR_MS = 3_600_000;

/**
 * 解析用户给的一个时间点。
 * 支持:now、"YYYY-MM-DD"、"YYYY-MM-DD HH:mm[:ss]"、"YYYY-MM-DDTHH:mm"、"HH:mm"(当天)、
 * "7d" / "12h" / "2w"(从现在往回数)。
 */
export function parsePoint(input: string | undefined, now: number, tz: string): number | null {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;
  if (/^now$/i.test(text)) return now;

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const hours = unit === 'h' ? 1 : unit === 'd' ? 24 : 24 * 7;
    return now - amount * hours * HOUR_MS;
  }

  const timeOnly = TIME_ONLY.exec(text);
  if (timeOnly) {
    const today = wallClock(now, tz);
    return wallToEpoch(today.y, today.m, today.d, Number(timeOnly[1]), Number(timeOnly[2]), 0, tz);
  }

  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    return wallToEpoch(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0, tz);
  }

  const dateTime = DATE_TIME.exec(text);
  if (dateTime) {
    return wallToEpoch(
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
      Number(dateTime[6] ?? 0),
      tz,
    );
  }

  // 最后兜底:带时区偏移的 ISO
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
