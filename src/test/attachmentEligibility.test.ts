import { describe, expect, it } from 'vitest';
import { ATTACHMENT_SIZE_LIMIT, classifyAttachmentEligibility } from '../utils/attachmentEligibility';
import type { JiraAttachment } from '../jira/IJiraClient';

function makeAttachment(overrides: Partial<JiraAttachment>): JiraAttachment {
  return {
    id: '1',
    filename: 'file.txt',
    mimeType: 'text/plain',
    size: 1024,
    content: 'https://jira.example.com/secure/attachment/1/file.txt',
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
