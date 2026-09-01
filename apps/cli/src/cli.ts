#!/usr/bin/env node
/**
 * GMGO CLI entry point. Phase 1 adds `login` (browser → loopback callback → API key), `logout`,
 * `whoami` and an example tenant-scoped command; see docs/CONCEPTS.md → CLI.
 */
import { Command } from 'commander'

const program = new Command()
program.name('gmgo').description('GMGO kit command-line interface').version('0.1.0')

program
  .command('hello')
  .description('Smoke-test command (replaced in Phase 1)')
  .action(() => {
    console.log('gmgo cli ready')
  })

program.parseAsync(process.argv)
