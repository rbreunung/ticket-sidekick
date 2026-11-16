import type { ImportHandler } from './handlers';
import { newTabHandler } from './newTab';
import { ticketedTabHandler } from './ticketedTab';
import { staleTabHandler } from './staleTab';
import { acceptedTabHandler } from './acceptedTab';
import { mergeTabHandler } from './mergeTab';
import { searchExportHandler } from './searchExport';

/** Every handler of the import board, asked in this order. */
export const IMPORT_HANDLERS: readonly ImportHandler[] = [
  mergeTabHandler, newTabHandler, ticketedTabHandler, staleTabHandler, acceptedTabHandler, searchExportHandler,
];
