import { describe, expect, it } from 'vitest';
import {
  resolveTicketKeyForUpload,
  buildUploadConfirmationMessage,
  buildUploadResultMessage,
} from '../participant/sessionState';

describe('resolveTicketKeyForUpload', () => {
  it('prefers a ticket key found in the prompt text over the filename and last-ticket context', () => {
    const key = resolveTicketKeyForUpload('upload the report to PROJ-123', 'OTHER-9-report.pdf', 'THIRD-1');
    expect(key).toBe('PROJ-123');
  });

  it('falls back to a ticket key embedded in the filename when the text has none', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'PROJ-123-report.pdf', 'THIRD-1');
    expect(key).toBe('PROJ-123');
  });

  it('falls back to the last-referenced ticket when text and filename have no key', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'report.pdf', 'THIRD-1');
    expect(key).toBe('THIRD-1');
  });

  it('returns null when no source has a ticket key', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'report.pdf', null);
    expect(key).toBeNull();
  });
});

describe('buildUploadConfirmationMessage', () => {
  it('renders a single file with its size and the target ticket', () => {
    const message = buildUploadConfirmationMessage('PROJ-123', [{ name: 'report.pdf', size: 2_097_152 }]);
    expect(message).toContain('PROJ-123');
    expect(message).toContain('report.pdf');
    expect(message).toContain('2.0 MB');
  });

  it('renders one line per file for multiple files', () => {
    const message = buildUploadConfirmationMessage('PROJ-123', [
      { name: 'a.pdf', size: 1024 },
      { name: 'b.pdf', size: 2048 },
      { name: 'c.pdf', size: 4096 },
    ]);
    expect(message).toContain('a.pdf');
    expect(message).toContain('b.pdf');
    expect(message).toContain('c.pdf');
  });
});

describe('buildUploadResultMessage', () => {
  it('renders each file\'s own success or failure outcome', () => {
    const message = buildUploadResultMessage('PROJ-123', [
      { name: 'a.pdf', ok: true },
      { name: 'b.pdf', ok: false, error: 'network error' },
    ]);
    expect(message).toContain('a.pdf');
    expect(message).toContain('b.pdf');
    expect(message).toContain('network error');
  });
});
