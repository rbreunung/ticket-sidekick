import { describe, it, expect, vi } from 'vitest';
import { readTicketGuarded, safeErrorText } from '../review/ticketRead';

describe('readTicketGuarded', () => {
  it('passes a successful read through', async () => {
    const ok = { ok: true, source: { key: 'PROJ-1' } } as never;
    await expect(readTicketGuarded(async () => ok)).resolves.toBe(ok);
  });

  it('turns a read that never settles into a failure the review can continue from', async () => {
    vi.useFakeTimers();
    try {
      const pending = readTicketGuarded(() => new Promise(() => {}), 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual({ ok: false, reason: 'error', message: 'timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a throwing read into a failure instead of failing the review', async () => {
    await expect(readTicketGuarded(async () => { throw new Error('boom'); }))
      .resolves.toEqual({ ok: false, reason: 'error', message: 'boom' });
  });
});

describe('error text from a remote server', () => {
  const hostile = 'Jira API error 502 — [click here](https://evil.example/x) <https://evil.example/y> ![i](https://evil.example/p.png) **bold** `code`';

  it('is flattened so it renders no link, autolink, image or emphasis', () => {
    const out = safeErrorText(hostile, 400);
    expect(out).not.toMatch(/\[[^\]]*\]\(/);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/[<>*`]/);
    expect(out).toContain('502');
  });

  it('is cut to the length limit on one line', () => {
    expect(safeErrorText('a\n\nb '.repeat(200), 50)).toHaveLength(50);
  });
});
