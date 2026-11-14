import { fileURLToPath } from 'node:url'

/** Storage state auth.setup.ts saves on a deployed env (git-ignored). */
export const authFile = fileURLToPath(new URL('../playwright/.auth/user.json', import.meta.url))
