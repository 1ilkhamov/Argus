import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Well-known IANA timezone aliases for convenience */
const TIMEZONE_ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'GMT',
  msk: 'Europe/Moscow',
  est: 'America/New_York',
  cst: 'America/Chicago',
  mst: 'America/Denver',
  pst: 'America/Los_Angeles',
  cet: 'Europe/Berlin',
  eet: 'Europe/Helsinki',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  ist: 'Asia/Kolkata',
  cst_cn: 'Asia/Shanghai',
  uzt: 'Asia/Tashkent',
};

@Injectable()
export class DateTimeTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(DateTimeTool.name);

  readonly definition: ToolDefinition = {
    name: 'datetime',
    description:
      'Get the current date, time, and day of the week. Can also convert between timezones and compute date differences. Use this whenever the user asks "what time is it", "what day is today", or needs timezone conversions.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Action to perform: "now" for current date/time, "convert" to convert between timezones, "diff" to compute difference between two dates.',
          enum: ['now', 'convert', 'diff'],
        },
        timezone: {
          type: 'string',
          description:
            'IANA timezone name (e.g. "Asia/Tashkent", "Europe/Moscow", "America/New_York") or shorthand (e.g. "utc", "msk", "est", "uzt"). Used with "now" and as the target timezone for "convert". Defaults to UTC.',
        },
        from_timezone: {
          type: 'string',
          description: 'Source timezone for "convert" action. Same format as timezone.',
        },
        datetime: {
          type: 'string',
          description:
            'ISO 8601 datetime string for "convert" (e.g. "2026-03-25T14:00:00") or start date for "diff" (e.g. "2026-03-25").',
        },
        datetime_end: {
          type: 'string',
          description: 'End date for "diff" action (e.g. "2026-04-01").',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('DateTime tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = (args.action as string) || 'now';

    switch (action) {
      case 'now':
        return this.getCurrentDateTime(args.timezone as string | undefined);
      case 'convert':
        return this.convertTimezone(
          args.datetime as string | undefined,
          args.from_timezone as string | undefined,
          args.timezone as string | undefined,
        );
      case 'diff':
        return this.dateDiff(
          args.datetime as string | undefined,
          args.datetime_end as string | undefined,
        );
      default:
        return `Unknown action: "${action}". Use "now", "convert", or "diff".`;
    }
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────

  private getCurrentDateTime(timezone?: string): string {
    const tz = resolveTimezone(timezone);
    const now = new Date();

    const formatted = formatInTimezone(now, tz);
    const utcFormatted = formatInTimezone(now, 'UTC');
    const unixTimestamp = Math.floor(now.getTime() / 1000);

    const lines = [
      `Current date and time:`,
      ``,
      `Timezone: ${tz}`,
      `Date: ${formatted.date}`,
      `Time: ${formatted.time}`,
      `Day of week: ${formatted.weekday}`,
      `ISO 8601: ${now.toISOString()}`,
      `Unix timestamp: ${unixTimestamp}`,
    ];

    if (tz !== 'UTC') {
      lines.push(``, `UTC equivalent: ${utcFormatted.date} ${utcFormatted.time}`);
    }

    return lines.join('\n');
  }

  private convertTimezone(
    datetime?: string,
    fromTimezone?: string,
    toTimezone?: string,
  ): string {
    if (!datetime) {
      return 'Error: "datetime" parameter is required for convert action (e.g. "2026-03-25T14:00:00").';
    }

    const fromTz = resolveTimezone(fromTimezone);
    const toTz = resolveTimezone(toTimezone);

    // Parse the datetime as if it's in the source timezone
    const date = parseDateInTimezone(datetime, fromTz);
    if (!date || isNaN(date.getTime())) {
      return `Error: Invalid datetime "${datetime}". Use ISO 8601 format (e.g. "2026-03-25T14:00:00").`;
    }

    const fromFormatted = formatInTimezone(date, fromTz);
    const toFormatted = formatInTimezone(date, toTz);

    return [
      `Timezone conversion:`,
      ``,
      `From: ${fromFormatted.date} ${fromFormatted.time} ${fromFormatted.weekday} (${fromTz})`,
      `To:   ${toFormatted.date} ${toFormatted.time} ${toFormatted.weekday} (${toTz})`,
    ].join('\n');
  }

  private dateDiff(startDate?: string, endDate?: string): string {
    if (!startDate || !endDate) {
      return 'Error: Both "datetime" (start) and "datetime_end" (end) are required for diff action.';
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return `Error: Invalid date(s). Use ISO 8601 format (e.g. "2026-03-25").`;
    }

    const diffMs = end.getTime() - start.getTime();
    const absDiffMs = Math.abs(diffMs);
    const isPast = diffMs < 0;

    const totalDays = Math.floor(absDiffMs / (1000 * 60 * 60 * 24));
    const totalHours = Math.floor(absDiffMs / (1000 * 60 * 60));
    const totalMinutes = Math.floor(absDiffMs / (1000 * 60));

    const weeks = Math.floor(totalDays / 7);
    const remainingDays = totalDays % 7;

    const direction = isPast ? 'in the past' : 'in the future';

    const lines = [
      `Date difference:`,
      ``,
      `From: ${startDate}`,
      `To:   ${endDate}`,
      ``,
      `Difference: ${totalDays} day(s) (${direction})`,
    ];

    if (weeks > 0) {
      lines.push(`  = ${weeks} week(s) and ${remainingDays} day(s)`);
    }

    lines.push(`  = ${totalHours} hour(s)`);
    lines.push(`  = ${totalMinutes} minute(s)`);

    return lines.join('\n');
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function resolveTimezone(input?: string): string {
  if (!input) return 'UTC';

  const normalized = input.trim().toLowerCase();
  if (TIMEZONE_ALIASES[normalized]) {
    return TIMEZONE_ALIASES[normalized]!;
  }

  // Validate the timezone by trying to use it
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.trim() });
    return input.trim();
  } catch {
    return 'UTC';
  }
}

function formatInTimezone(
  date: Date,
  timezone: string,
): { date: string; time: string; weekday: string } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
  const timeStr = date.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const weekday = date.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });

  return { date: dateStr, time: timeStr, weekday };
}

function parseDateInTimezone(datetime: string, timezone: string): Date {
  // Try to interpret the datetime string as being in the given timezone
  // by formatting it back and using the offset
  const naive = new Date(datetime);
  if (isNaN(naive.getTime())) return naive;

  // If the datetime already has timezone info (Z, +05:00, etc.), use as-is
  if (/[Zz]|[+-]\d{2}:\d{2}$/.test(datetime.trim())) {
    return naive;
  }

  // Otherwise, calculate the offset for the source timezone
  const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = naive.toLocaleString('en-US', { timeZone: timezone });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  const offsetMs = utcDate.getTime() - tzDate.getTime();

  return new Date(naive.getTime() + offsetMs);
}
