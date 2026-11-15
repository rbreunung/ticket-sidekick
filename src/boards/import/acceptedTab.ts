import type { ImportHandler } from './handlers';

// The import board's handler for accepting and unaccepting Waltz CVEs and components, and reloading the report. vscode-free.

export const acceptedTabHandler: ImportHandler = {
  name: 'accepted',
};
