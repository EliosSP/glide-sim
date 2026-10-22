/**
 * Test log (spec chapter 9): one row per event and one summary row per trial, kept in memory,
 * mirrored to localStorage (a reload does not lose data) and exported as two CSV files.
 * Nothing heavy per frame: events are rare, the storage write is debounced.
 */

export interface LogRow {
  session_id: string;
  participant_id: string;
  trial: number;
  t_ms: number; // from the start of the trial (simulation clock)
  event: string;
  phase: string;
  side: string;
  value: string;
  extra_json: string;
}

export type Outcome = 'done' | 'cancel' | 'reset' | 'in_corso';

interface Trial {
  trial: number;
  participant: string;
  startedAt: string; // wall clock, ISO
  t0: number; // simulation seconds
  params: Record<string, unknown>;
  outcome: Outcome | null;
  endT: number | null;
}

const STORAGE_KEY = 'glide-log-v1';
const ASSISTED_PHASES = ['positioning', 'steer1', 'reverse1', 'steer2', 'reverse2', 'inside'];

const EVENT_COLUMNS: (keyof LogRow)[] = ['session_id', 'participant_id', 'trial', 't_ms', 'event', 'phase', 'side', 'value', 'extra_json'];

export class Logger {
  enabled = true;
  sessionId = newSessionId();
  private events: LogRow[] = [];
  private trials: Trial[] = [];
  private saveTimer: number | null = null;

  constructor() {
    this.restore();
    // The debounced write could miss the last second before a reload or a closed tab
    window.addEventListener('pagehide', () => this.save());
  }

  get current() {
    return this.trials[this.trials.length - 1] ?? null;
  }

  get eventCount() {
    return this.events.length;
  }

  startTrial(trial: number, participant: string, now: number, params: Record<string, unknown>) {
    this.trials.push({ trial, participant, startedAt: new Date().toISOString(), t0: now, params, outcome: null, endT: null });
    this.log(now, 'trial_start');
  }

  /** Closes the current trial (reset, or a new session); an outcome already set (done, cancel) is kept. */
  endTrial(now: number, outcome: Outcome) {
    const t = this.current;
    if (!t || t.endT !== null) return;
    t.outcome ??= outcome;
    t.endT = now;
    this.log(now, 'reset');
    this.save();
  }

  /** Marks how the trial went without closing it (the participant may go on driving). Parking wins over a cancel. */
  setOutcome(outcome: Outcome) {
    const t = this.current;
    if (t && (outcome === 'done' || t.outcome === null)) t.outcome = outcome;
  }

  log(now: number, event: string, f: { phase?: string; side?: string | null; value?: string | number; extra?: Record<string, unknown> } = {}) {
    const t = this.current;
    if (!this.enabled || !t) return;
    this.events.push({
      session_id: this.sessionId,
      participant_id: t.participant,
      trial: t.trial,
      t_ms: Math.round((now - t.t0) * 1000),
      event,
      phase: f.phase ?? '',
      side: f.side ?? '',
      value: f.value === undefined ? '' : typeof f.value === 'number' ? String(Math.round(f.value * 1000) / 1000) : f.value,
      extra_json: f.extra ? JSON.stringify(f.extra) : '',
    });
    this.scheduleSave();
  }

  /** Participant ID changed during the current trial (typed after loading the page). */
  setParticipant(id: string) {
    const t = this.current;
    if (!t) return;
    t.participant = id;
    for (const e of this.events) if (e.trial === t.trial && e.session_id === this.sessionId) e.participant_id = id;
  }

  newSession() {
    this.events = [];
    this.trials = [];
    this.sessionId = newSessionId();
    this.save();
  }

  // ---------- CSV ----------

  eventsCsv() {
    return toCsv(EVENT_COLUMNS, this.events.map((e) => EVENT_COLUMNS.map((c) => e[c])));
  }

  summaryCsv(now: number) {
    const rows = this.trials.map((t) => this.summarize(t, now));
    const cols = Object.keys(rows[0] ?? { trial: '' });
    return toCsv(cols, rows.map((r) => cols.map((c) => r[c])));
  }

  private summarize(t: Trial, now: number): Record<string, string | number> {
    const ev = this.events.filter((e) => e.trial === t.trial && e.session_id === this.sessionId);
    const count = (name: string) => ev.filter((e) => e.event === name).length;
    const last = (name: string) => [...ev].reverse().find((e) => e.event === name);
    const end = t.endT ?? now;

    // Time per assisted phase: from each phase event to the next one (or the end)
    const phaseTime: Record<string, number> = {};
    const phases = ev.filter((e) => e.event === 'phase');
    phases.forEach((p, i) => {
      const until = phases[i + 1]?.t_ms ?? Math.round((end - t.t0) * 1000);
      phaseTime[p.value] = (phaseTime[p.value] ?? 0) + (until - p.t_ms) / 1000;
    });
    const steerErrors = ev.filter((e) => e.event === 'steer_error').map((e) => Number(e.value));
    const meanAbs = steerErrors.length ? steerErrors.reduce((a, b) => a + Math.abs(b), 0) / steerErrors.length : '';
    const final = last('done') ?? last('auto_done');
    const fx = final?.extra_json ? (JSON.parse(final.extra_json) as Record<string, number>) : {};
    const autoStart = last('auto_start');
    const autoDone = last('auto_done');
    const cm = (m: number | undefined) => (m === undefined || !isFinite(m) ? '' : Math.round(m * 100));

    return {
      session_id: this.sessionId,
      participant_id: t.participant,
      trial: t.trial,
      started_at: t.startedAt,
      outcome: t.outcome ?? (t.endT === null ? 'in_corso' : 'reset'),
      mode: last('mode_chosen')?.value ?? '',
      total_s: round1(end - t.t0),
      ...Object.fromEntries(ASSISTED_PHASES.map((p) => [`t_${p}_s`, phaseTime[p] !== undefined ? round1(phaseTime[p]) : ''])),
      auto_s: autoStart && autoDone ? round1((autoDone.t_ms - autoStart.t_ms) / 1000) : '',
      overs: count('over'),
      steer_errors_pct: steerErrors.map((e) => Math.round(e * 100)).join(' '),
      steer_error_mean_abs_pct: meanAbs === '' ? '' : Math.round(meanAbs * 100),
      contacts: count('contact'),
      curb_cm: cm(fx.curbGap),
      front_cm: cm(fx.frontGap),
      rear_cm: cm(fx.rearGap),
      takeovers: count('takeover'),
      switch_to_assisted: count('switch_to_assisted'),
      cancels: count('cancel'),
      glances: ev.filter((e) => e.event === 'glance' && e.value === 'start').length,
      params_json: JSON.stringify(t.params),
    };
  }

  // ---------- storage ----------

  private scheduleSave() {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: this.sessionId, events: this.events, trials: this.trials }));
    } catch {
      // storage unavailable or full: the log stays in memory
    }
  }

  private restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      this.sessionId = d.sessionId;
      this.events = d.events ?? [];
      // A trial interrupted by the reload is closed as reset
      this.trials = (d.trials ?? []).map((t: Trial) => (t.endT === null ? { ...t, endT: t.t0, outcome: t.outcome ?? 'reset' } : t));
    } catch {
      // nothing stored, or unreadable
    }
  }

  /** Participant of the last trial of the restored session (empty for a new session). */
  get lastParticipant() {
    return this.current?.participant ?? '';
  }

  /** Last trial number of the restored session (so numbering continues after a reload). */
  get lastTrial() {
    return this.trials.reduce((m, t) => Math.max(m, t.trial), 0);
  }
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

function newSessionId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvCell(v: unknown) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(cols: string[], rows: unknown[][]) {
  return [cols.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}

/** Browser download of a text file. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
