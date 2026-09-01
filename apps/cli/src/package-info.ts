/**
 * Package metadata for the CLI (D26). The bin name, version and prefix all derive from
 * `package.json`, so ADAPTING renames the CLI by editing `name`/`bin` there — nothing here.
 */
import pkg from '../package.json'

export const PACKAGE_NAME: string = pkg.name
export const VERSION: string = pkg.version
export const BIN_NAME: string = Object.keys(pkg.bin)[0] ?? 'rocketflare'
