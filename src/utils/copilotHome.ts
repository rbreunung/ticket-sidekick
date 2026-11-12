import * as path from 'path';

/** The Copilot home folder: `COPILOT_HOME` when set, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv, homedir: string): string {
  const custom = env.COPILOT_HOME?.trim();
  return custom ? custom : path.join(homedir, '.copilot');
}
