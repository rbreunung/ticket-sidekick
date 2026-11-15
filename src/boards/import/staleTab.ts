import type { ImportHandler } from './handlers';

// The import board's handler for the Stale tab: marking stale tickets and closing them by issue type. vscode-free.

export const staleTabHandler: ImportHandler = {
  name: 'stale',
};
