import { useEffect, useState } from 'react';
import { theme } from '../theme';
import type { RecordingSearchFilter } from '../../../shared/types';

interface Props {
  selectedDate: string; // 'YYYY-MM-DD'
  onSelect: (date: string) => void;
  // When set, days with at least one matching recording get a small dot —
  // lets the user see where footage actually exists before picking a date,
  // rather than searching blind day by day.
  deviceId: string | null;
  channel: number | null;
  filters: RecordingSearchFilter[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Small self-contained month-grid date picker, deliberately not a plain
// <input type="date"> — matches the reference VMS's own "Search Time"
// calendar, which the user asked this to resemble structurally (position
// at the bottom of the sidebar, month grid with faded lead/trail days from
// adjacent months).
export function MiniCalendar({ selectedDate, onSelect, deviceId, channel, filters }: Props) {
  const selected = new Date(`${selectedDate}T00:00:00`);
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());
  const [recordingDays, setRecordingDays] = useState<Set<number>>(new Set());

  // One search covering the whole visible month rather than one call per
  // day — reuses the exact same findRecordings the day-view search already
  // calls, just with a wider time range; the per-segment detail isn't
  // needed here, only which calendar day each segment's start falls on.
  // Passes quick=true — vendors whose Motion/Smart search costs extra
  // round trips (see VmsAdapter.findRecordings' doc comment) can skip that
  // and search continuous-only for this "which days have anything" check;
  // the day-view search below still runs the full accurate query.
  useEffect(() => {
    if (!deviceId || channel === null) {
      setRecordingDays(new Set());
      return;
    }
    let cancelled = false;
    const monthStartMs = new Date(viewYear, viewMonth, 1).getTime();
    const monthEndMs = new Date(viewYear, viewMonth + 1, 1).getTime();
    // Diagnostic: reported live that switching devices left the calendar
    // showing the PREVIOUS device's day dots — not yet reproduced through
    // static reading (this effect's own deps already include deviceId and
    // channel, and the cache key in recordingCalendarCache.ts already
    // includes both too), so logging real values here rather than guessing
    // further at the cause.
    // eslint-disable-next-line no-console
    console.log('[calendar-diag] effect firing deviceId=%s channel=%s month=%d-%d', deviceId, channel, viewYear, viewMonth);
    window.ssmVms.playback
      .findRecordings(deviceId, channel, monthStartMs, monthEndMs, filters, true)
      .then((segments) => {
        // eslint-disable-next-line no-console
        console.log(
          '[calendar-diag] result deviceId=%s channel=%s cancelled=%s segmentCount=%d',
          deviceId, channel, cancelled, segments.length,
        );
        if (cancelled) return;
        setRecordingDays(new Set(segments.map((s) => new Date(s.startMs).getDate())));
      })
      .catch((err) => {
        // Was silently swallowed before — a failed month-wide search left
        // the calendar with no dots and no visible sign anything went
        // wrong. Logged so a real failure (e.g. the device rejecting a
        // multi-week search range) shows up instead of looking identical
        // to "no recordings this month".
        // eslint-disable-next-line no-console
        console.error('Calendar month recording search failed', err);
        if (!cancelled) setRecordingDays(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, channel, filters, viewYear, viewMonth]);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  // JS getDay() is Sun-first (0-6) — this calendar is Mon-first, matching
  // the reference screenshot's header row.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { day: number; year: number; month: number; inCurrentMonth: boolean }[] = [];
  for (let i = leadingBlanks - 1; i >= 0; i--) {
    const month = viewMonth === 0 ? 11 : viewMonth - 1;
    const year = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ day: daysInPrevMonth - i, year, month, inCurrentMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ day, year: viewYear, month: viewMonth, inCurrentMonth: true });
  }
  const trailingBlanks = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7 - leadingBlanks - daysInMonth;
  const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1;
  const nextMonthYear = viewMonth === 11 ? viewYear + 1 : viewYear;
  for (let day = 1; day <= trailingBlanks; day++) {
    cells.push({ day, year: nextMonthYear, month: nextMonth, inCurrentMonth: false });
  }

  function changeMonth(delta: number): void {
    let month = viewMonth + delta;
    let year = viewYear;
    if (month < 0) {
      month = 11;
      year -= 1;
    } else if (month > 11) {
      month = 0;
      year += 1;
    }
    setViewMonth(month);
    setViewYear(year);
  }

  function changeYear(delta: number): void {
    setViewYear(viewYear + delta);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.2rem' }}>
          <NavButton onClick={() => changeYear(-1)} label="«" />
          <NavButton onClick={() => changeMonth(-1)} label="‹" />
        </div>
        <div style={{ fontSize: '12px', fontWeight: 600, color: theme.text }}>
          {viewYear} {MONTH_NAMES[viewMonth]}
        </div>
        <div style={{ display: 'flex', gap: '0.2rem' }}>
          <NavButton onClick={() => changeMonth(1)} label="›" />
          <NavButton onClick={() => changeYear(1)} label="»" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '2px' }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: '9.5px', color: theme.textFaint, padding: '2px 0' }}>
            {w}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
        {cells.map((cell, i) => {
          const dateStr = toDateStr(cell.year, cell.month, cell.day);
          const isSelected = dateStr === selectedDate;
          const hasRecording = cell.inCurrentMonth && recordingDays.has(cell.day);
          return (
            <button
              key={i}
              onClick={() => onSelect(dateStr)}
              style={{
                position: 'relative',
                padding: '4px 0',
                borderRadius: '3px',
                border: 'none',
                background: isSelected ? theme.accent : 'transparent',
                color: isSelected ? theme.accentText : cell.inCurrentMonth ? theme.text : theme.textFaint,
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              {cell.day}
              {hasRecording && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: '2px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '3px',
                    height: '3px',
                    borderRadius: '50%',
                    background: isSelected ? theme.accentText : theme.text,
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '18px',
        height: '18px',
        border: 'none',
        background: 'transparent',
        color: theme.textMuted,
        fontSize: '11px',
        cursor: 'pointer',
        borderRadius: '3px',
      }}
    >
      {label}
    </button>
  );
}
