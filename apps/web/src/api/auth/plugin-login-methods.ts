/**
 * The login methods installed plugins contribute (`ServerPlugin.loginMethods`), as
 * `GET /auth/methods` answers them. Pure over the plugin list, so the route passes the barrel and
 * `tests/config/plugins.test.ts` passes a fixture.
 *
 * One rule, checked twice: a method's `startPath` is under the plugin's OWN public mount
 * (`/api/hooks/<id>/…`). The login page navigates a signed-out browser there, so a path anywhere
 * else would make the kit's login page a door into a route the plugin does not own. The test
 * fails such a plugin; at runtime the method is dropped and logged, never rendered.
 */
import type { PluginLoginMethod } from '@rocketflare/shared/auth'
import type { AppConfig } from '../../config'
import type { Logger } from '../utils/core/logger'

/** What a plugin declares; the host namespaces `id` as `<plugin id>:<id>` on the wire. */
export interface PluginLoginMethodDeclaration {
  /** Unique within the plugin: `sso`, `okta-acme`. */
  id: string
  /** The button text: "Sign in with SSO". */
  label: string
  /** Under `/api/hooks/<plugin id>/`; a GET the browser navigates to. No query string. */
  startPath: string
  /** Ask for the email first and send it as `?email=` (home-realm discovery). */
  askEmail?: boolean
}

interface LoginMethodSource {
  shared: { id: string }
  loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]
}

/** Why this declaration may not be shown, or null when it may. */
export function loginMethodIssue(
  pluginId: string,
  method: PluginLoginMethodDeclaration
): string | null {
  const root = `/api/hooks/${pluginId}/`
  if (!method.startPath.startsWith(root) || method.startPath.length === root.length) {
    return `${pluginId}: login method '${method.id}' starts at '${method.startPath}', outside ${root}`
  }
  if (/[?#]/.test(method.startPath) || method.startPath.includes('..')) {
    return `${pluginId}: login method '${method.id}' startPath carries a query, fragment or '..'`
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(method.id)) {
    return `${pluginId}: login method id '${method.id}' must be lower-case letters, digits, '-'`
  }
  return null
}

export function pluginLoginMethods(
  plugins: readonly LoginMethodSource[],
  cfg: AppConfig,
  logger?: Pick<Logger, 'warn'>
): PluginLoginMethod[] {
  const methods: PluginLoginMethod[] = []
  for (const plugin of plugins) {
    let declared: readonly PluginLoginMethodDeclaration[]
    try {
      declared = plugin.loginMethods?.(cfg) ?? []
    } catch (err) {
      // One broken plugin must not take the login page down with it.
      logger?.warn({ err, plugin: plugin.shared.id }, 'plugin loginMethods threw; skipped')
      continue
    }
    for (const method of declared) {
      const issue = loginMethodIssue(plugin.shared.id, method)
      if (issue) {
        logger?.warn({ plugin: plugin.shared.id }, issue)
        continue
      }
      methods.push({
        id: `${plugin.shared.id}:${method.id}`,
        label: method.label,
        startPath: method.startPath,
        ...(method.askEmail ? { askEmail: true } : {}),
      })
    }
  }
  return methods
}
