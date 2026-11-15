import type { ImportHandler } from './handlers';

// The import board's handler for the New tab: selecting, merging and unmerging rows, adding rows to an existing ticket, and creating tickets. vscode-free.

export const newTabHandler: ImportHandler = {
  name: 'new',
};
