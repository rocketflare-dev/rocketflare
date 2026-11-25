/**
 * Package metadata for the CLI. The bin name, version and prefix all derive from
 * `package.json`, so renaming the CLI means editing `name`/`bin` there — nothing here.
 */
import pkg from '../package.json'

export const PACKAGE_NAME: string = pkg.name
export const VERSION: string = pkg.version
export const BIN_NAME: string = Object.keys(pkg.bin)[0] ?? 'rocketflare'
