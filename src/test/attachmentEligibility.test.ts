import { describe, expect, it } from 'vitest';
import { ATTACHMENT_SIZE_LIMIT, classifyAttachmentEligibility, findAttachmentByFilename } from '../utils/attachmentEligibility';
import type { JiraAttachment } from '../jira/IJiraClient';

function makeAttachment(overrides: Partial<JiraAttachment>): JiraAttachment {
  return {
    id: '1',
    filename: 'file.txt',
    mimeType: 'text/plain',
    size: 1024,
    content: 'https://jira.example.com/secure/attachment/1/file.txt',
    created: '2024-01-01T00:00:00.000+0000',
    ...overrides,
  };
}

describe('classifyAttachmentEligibility', () => {
  it('sorts a text file, an image, and a known-extension document into toDownload', () => {
    const attachments = [
      makeAttachment({ filename: 'error.log', mimeType: 'text/plain' }),
      makeAttachment({ filename: 'screenshot.png', mimeType: 'image/png' }),
      makeAttachment({ filename: 'report.pdf', mimeType: 'application/pdf' }),
    ];

    const { toDownload, toSkip } = classifyAttachmentEligibility(attachments);

    expect(toDownload.map((a) => a.filename)).toEqual(['error.log', 'screenshot.png', 'report.pdf']);
    expect(toSkip).toEqual([]);
  });

  it('skips a file over ATTACHMENT_SIZE_LIMIT regardless of MIME type', () => {
    const oversized = makeAttachment({ filename: 'huge.txt', mimeType: 'text/plain', size: ATTACHMENT_SIZE_LIMIT + 1 });

    const { toDownload, toSkip } = classifyAttachmentEligibility([oversized]);

    expect(toDownload).toEqual([]);
    expect(toSkip).toEqual([oversized]);
  });

  it('skips an unknown binary MIME type with no matching extension', () => {
    const unknown = makeAttachment({ filename: 'heap-dump.bin', mimeType: 'application/octet-stream' });

    const { toDownload, toSkip } = classifyAttachmentEligibility([unknown]);

    expect(toDownload).toEqual([]);
    expect(toSkip).toEqual([unknown]);
  });

  it('returns empty toDownload/toSkip for an empty attachment list', () => {
    expect(classifyAttachmentEligibility([])).toEqual({ toDownload: [], toSkip: [] });
  });
});

describe('findAttachmentByFilename (R9/R10, KTD5/KTD7)', () => {
  it('returns the single attachment matching the exact filename', () => {
    const target = makeAttachment({ filename: 'report.log', id: '2' });
    const attachments = [makeAttachment({ filename: 'other.log', id: '1' }), target];

    expect(findAttachmentByFilename(attachments, 'report.log')).toBe(target);
  });

  it('returns undefined when no attachment matches', () => {
    const attachments = [makeAttachment({ filename: 'other.log' })];

    expect(findAttachmentByFilename(attachments, 'missing.log')).toBeUndefined();
  });

  it('picks the attachment with the latest created timestamp when the filename is duplicated', () => {
    const older = makeAttachment({ filename: 'report.log', id: '1', created: '2024-01-10T09:00:00.000+0000' });
    const newer = makeAttachment({ filename: 'report.log', id: '2', created: '2024-01-20T09:00:00.000+0000' });

    expect(findAttachmentByFilename([older, newer], 'report.log')).toBe(newer);
    expect(findAttachmentByFilename([newer, older], 'report.log')).toBe(newer);
  });
});
