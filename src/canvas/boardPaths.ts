// The two paths the canvas program calls on a window's server, kept apart from the board routes
// so the canvas program's bundle does not pull the session code in.

/** Validates an open request and answers with the board's session, or the reason it cannot open. */
export const BOARD_OPEN_PATH = '/api/open';
/** Answers when the address still reaches a running window. */
export const BOARD_PING_PATH = '/api/ping';
