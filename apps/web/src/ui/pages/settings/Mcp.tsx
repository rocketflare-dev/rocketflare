/**
 * Settings → MCP: whether AI clients (Claude, ChatGPT) may connect to this organisation, who may
 * connect, and which tools they reach. Every client acts as the person who connected it, with that
 * person's own permissions — the settings here only ever narrow that.
 *
 * The switch, the connect policy and the exposure mode save as soon as they change; the two
 * checkbox lists (chosen groups, selected tools) keep a draft and save on "Save". Enabling every
 * tool asks first: writes then reach clients. Whether a row is exposed comes from the server
 * (`exposed` on each tool), never re-derived here. Owners and admins only, and only where the
 * deployment ships `mcp` (the tab's guard).
 */
import type { McpConnectPolicy, McpExposure, McpToolListing } from '@rocketflare/shared/mcp'
import { sharedPlugins } from '@rocketflare/shared/plugins'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { McpConnectionsTable } from '@/ui/components/mcp/McpConnectionsTable'
import {
  ConfirmModal,
  EmptyState,
  SectionPanel,
  SettingToggle,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { useGroups } from '@/ui/hooks/useGroups'
import {
  useMcpConnections,
  useMcpSettings,
  useMcpTools,
  useRevokeAllMcpConnections,
  useRevokeMcpConnection,
  useUpdateMcpSettings,
} from '@/ui/hooks/useMcp'

/** The name a CLI wants: lower-case, dashes, nothing else (`Acme Tools` → `acme-tools`). */
export function cliServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'mcp'
}

const PROVIDER_CORE = 'core'

function providerLabel(provider: string): string {
  if (provider === PROVIDER_CORE) return 'Knowledge'
  return sharedPlugins.find(p => p.id === provider)?.label ?? provider
}

const UNAVAILABLE_TEXT: Record<NonNullable<McpToolListing['unavailableReason']>, string> = {
  not_on_mcp: 'Its provider keeps it off MCP.',
  terminal: 'Ends an agent run; never offered to clients.',
  approval: 'Needs an approval, which MCP clients cannot give yet.',
}

const EXPOSURE_OPTIONS: { value: McpExposure; label: string; description: string }[] = [
  {
    value: 'read_only',
    label: 'All read-only tools',
    description: 'Every tool that only reads, including ones added later. Nothing can change data.',
  },
  {
    value: 'all',
    label: 'Enable all',
    description:
      'Every tool, including ones that make changes, and ones added later. A client still needs the "make changes" permission from the person who connects it.',
  },
  {
    value: 'selected',
    label: 'Selected',
    description: 'Only the tools ticked below.',
  },
]

const CONNECT_OPTIONS: { value: McpConnectPolicy; label: string; description: string }[] = [
  { value: 'everyone', label: 'Everyone', description: 'Any member of the organisation.' },
  { value: 'admins', label: 'Admins', description: 'Owners and admins only.' },
  { value: 'groups', label: 'Chosen groups', description: 'Members of the groups ticked below.' },
]

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="join w-full">
        <input
          id={id}
          readOnly
          value={value}
          className="input input-sm join-item w-full font-mono"
          onFocus={e => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn-sm join-item"
          onClick={async () => {
            await navigator.clipboard.writeText(value)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

function Snippet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="text-sm text-secondary">{children}</div>
    </div>
  )
}

function ConnectionSection() {
  const { tenancyMode } = useAuth()
  const { data, isLoading, isError } = useMcpSettings()
  const update = useUpdateMcpSettings()
  if (isLoading) return <SkeletonRows rows={2} />
  if (isError || !data) {
    return (
      <p className="text-sm text-error" role="alert">
        MCP settings could not be loaded.
      </p>
    )
  }
  const single = tenancyMode === 'single'
  // claude.ai keeps one connector per URL, so the organisation's own URL is the one to paste —
  // it is what lets someone connect a second organisation. Under single tenancy there is one.
  const url = single ? data.serverUrl : data.organisationServerUrl
  const name = data.serverName
  const cliName = cliServerName(name)
  return (
    <>
      <SectionPanel
        title="MCP server"
        description={`Let people use ${name} from AI clients such as Claude and ChatGPT. A client acts as the person who connects it, with their permissions, and they can revoke it at any time.`}
      >
        <SettingToggle
          id="mcp-enabled"
          label="Allow MCP clients"
          description={
            data.settings.enabled
              ? 'On: people allowed below can connect a client.'
              : 'Off: no client can connect, and existing connections are paused (not removed).'
          }
          checked={data.settings.enabled}
          disabled={update.isPending}
          onChange={enabled => update.mutate({ enabled })}
        />
        <div className="py-4 flex flex-col gap-3">
          <CopyField id="mcp-url" label="Server URL" value={url} />
          {!single && (
            <p className="text-sm text-secondary">
              This URL connects to this organisation. <code>{data.serverUrl}</code> works too, and
              asks which organisation when connecting, but a client that keeps one connection per
              URL (claude.ai) can then only reach one of them.
            </p>
          )}
        </div>
      </SectionPanel>

      <SectionPanel
        title="Connect a client"
        description="The client signs in through this app, then asks for the person's consent."
      >
        <div className="flex flex-col gap-4 py-2">
          <Snippet title="Claude (claude.ai and Claude Desktop)">
            Settings → Connectors → Add custom connector. Name it <strong>{name}</strong> and paste
            the server URL.
          </Snippet>
          <Snippet title="Claude Code">
            <pre className="mt-1 rounded bg-base-200 p-2 font-mono text-xs overflow-x-auto">
              <code>{`claude mcp add --transport http ${cliName} ${url}`}</code>
            </pre>
          </Snippet>
          <Snippet title="ChatGPT">
            Settings → Apps &amp; Connectors → Create (developer mode). Name it{' '}
            <strong>{name}</strong>, paste the server URL and choose OAuth.
          </Snippet>
          <p className="text-xs text-muted">
            Clients that register through Client ID Metadata Documents are supported; others (for
            example Cursor) cannot connect yet.
          </p>
        </div>
      </SectionPanel>
    </>
  )
}

function ConnectPolicySection() {
  const { data } = useMcpSettings()
  const update = useUpdateMcpSettings()
  const groups = useGroups(undefined, data?.settings.connectPolicy === 'groups')
  const saved = data?.settings.connectGroupIds
  const [draft, setDraft] = useState<string[] | null>(null)
  if (!data) return null
  const policy = data.settings.connectPolicy
  const chosen = draft ?? saved ?? []
  const dirty =
    draft !== null && draft.slice().sort().join() !== (saved ?? []).slice().sort().join()
  return (
    <SectionPanel title="Who can connect" description="Support staff can never connect a client.">
      <fieldset className="flex flex-col gap-2 py-2" aria-label="Who can connect">
        {CONNECT_OPTIONS.map(o => (
          <label key={o.value} className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="mcp-connect-policy"
              className="radio radio-sm mt-0.5"
              checked={policy === o.value}
              disabled={update.isPending}
              onChange={() => update.mutate({ connectPolicy: o.value })}
            />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-sm text-secondary">{o.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {policy === 'groups' && (
        <div className="flex flex-col gap-2 pb-2 pl-7">
          {groups.isLoading ? (
            <SkeletonRows rows={2} />
          ) : (groups.data?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-secondary">
              No groups yet. Create them under Settings → Groups.
            </p>
          ) : (
            groups.data?.items.map(g => (
              <label key={g.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={chosen.includes(g.id)}
                  onChange={e =>
                    setDraft(
                      e.target.checked ? [...chosen, g.id] : chosen.filter(id => id !== g.id)
                    )
                  }
                />
                {g.name} <span className="text-muted">({g.typeName})</span>
              </label>
            ))
          )}
          {chosen.length === 0 && (groups.data?.items.length ?? 0) > 0 && (
            <p className="text-sm text-warning">
              No group chosen: only owners and admins can connect.
            </p>
          )}
          {dirty && (
            <div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({ connectGroupIds: chosen }, { onSuccess: () => setDraft(null) })
                }
              >
                Save groups
              </button>
            </div>
          )}
        </div>
      )}
    </SectionPanel>
  )
}

function Badge({ children, tone }: { children: ReactNode; tone?: 'warning' | 'neutral' }) {
  return (
    <span className={`badge badge-sm ${tone === 'warning' ? 'badge-warning' : 'badge-ghost'}`}>
      {children}
    </span>
  )
}

function ToolRow({
  tool,
  selectable,
  checked,
  onToggle,
}: {
  tool: McpToolListing
  selectable: boolean
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  const unavailable = tool.unavailableReason !== null
  const a = tool.annotations
  return (
    <li
      className={`flex items-start gap-3 py-3 border-b border-[color:var(--border-subtle)] last:border-b-0 ${unavailable ? 'opacity-60' : ''}`}
      aria-disabled={unavailable || undefined}
    >
      {selectable && (
        <input
          type="checkbox"
          className="checkbox checkbox-sm mt-0.5"
          aria-label={`Expose ${tool.title ?? tool.name}`}
          checked={checked}
          disabled={unavailable}
          onChange={e => onToggle(e.target.checked)}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{tool.title ?? tool.name}</span>
          <code className="text-xs text-muted">{tool.name}</code>
          {tool.readOnly ? <Badge>read-only</Badge> : <Badge tone="warning">writes</Badge>}
          {a.destructiveHint && <Badge>destructive</Badge>}
          {a.idempotentHint && !tool.readOnly && <Badge>idempotent</Badge>}
          {a.openWorldHint && <Badge>reaches outside services</Badge>}
          {!unavailable && tool.exposed && <Badge>exposed</Badge>}
        </div>
        <p className="text-sm text-secondary mt-0.5 line-clamp-2">{tool.description}</p>
        {unavailable && tool.unavailableReason && (
          <p className="text-xs text-muted mt-0.5">{UNAVAILABLE_TEXT[tool.unavailableReason]}</p>
        )}
      </div>
      <span className="text-xs text-muted shrink-0 tabular-nums" title="Calls in the last 30 days">
        {tool.calls30d} {tool.calls30d === 1 ? 'call' : 'calls'}
      </span>
    </li>
  )
}

function ExposureSection() {
  const settings = useMcpSettings()
  const tools = useMcpTools()
  const update = useUpdateMcpSettings()
  const [confirmAll, setConfirmAll] = useState(false)
  const [draft, setDraft] = useState<string[] | null>(null)
  const groups = useMemo(() => {
    const byProvider = new Map<string, McpToolListing[]>()
    for (const t of tools.data?.tools ?? []) {
      byProvider.set(t.provider, [...(byProvider.get(t.provider) ?? []), t])
    }
    // Knowledge (core) first, then each plugin in the order the server lists them.
    return [...byProvider.entries()].sort(
      ([a], [b]) => Number(b === PROVIDER_CORE) - Number(a === PROVIDER_CORE)
    )
  }, [tools.data])
  if (!settings.data) return null
  const exposure = settings.data.settings.exposure
  const saved = settings.data.settings.exposedTools
  const selected = draft ?? saved
  const dirty = draft !== null && draft.slice().sort().join() !== saved.slice().sort().join()
  const choose = (value: McpExposure) => {
    if (value === exposure) return
    if (value === 'all') setConfirmAll(true)
    else update.mutate({ exposure: value })
  }
  return (
    <SectionPanel
      title="Tools"
      description="What a connected client can call. A tool also checks the person's own permissions on every call."
    >
      <fieldset className="flex flex-col gap-2 py-2" aria-label="Exposure">
        {EXPOSURE_OPTIONS.map(o => (
          <label key={o.value} className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="mcp-exposure"
              className="radio radio-sm mt-0.5"
              checked={exposure === o.value}
              disabled={update.isPending}
              onChange={() => choose(o.value)}
            />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-sm text-secondary">{o.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {tools.isLoading ? (
        <SkeletonRows rows={3} />
      ) : tools.isError ? (
        <p className="text-sm text-error" role="alert">
          Tools could not be loaded.
        </p>
      ) : (
        groups.map(([provider, list]) => (
          <section key={provider} className="pt-3" aria-label={providerLabel(provider)}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {providerLabel(provider)}
            </h4>
            <ul>
              {list.map(t => (
                <ToolRow
                  key={t.name}
                  tool={t}
                  selectable={exposure === 'selected'}
                  checked={selected.includes(t.name)}
                  onToggle={on =>
                    setDraft(on ? [...selected, t.name] : selected.filter(n => n !== t.name))
                  }
                />
              ))}
            </ul>
          </section>
        ))
      )}
      {exposure === 'selected' && dirty && (
        <div className="py-3">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({ exposedTools: selected }, { onSuccess: () => setDraft(null) })
            }
          >
            Save selection
          </button>
        </div>
      )}
      <ConfirmModal
        isOpen={confirmAll}
        title="Enable every tool?"
        message="Connected clients will be able to make changes as the people who connected them, through every tool that writes, including tools added later. Each person still has to grant a client the permission to make changes."
        confirmText="Enable all"
        confirmButtonClass="btn-warning"
        isLoading={update.isPending}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() =>
          update.mutate({ exposure: 'all' }, { onSettled: () => setConfirmAll(false) })
        }
      />
    </SectionPanel>
  )
}

/** Every live connection in the organisation, with Revoke and Revoke all. */
function ConnectedClientsSection() {
  const connections = useMcpConnections()
  const revoke = useRevokeMcpConnection('tenant')
  const revokeAll = useRevokeAllMcpConnections()
  const [confirmAll, setConfirmAll] = useState(false)
  const items = connections.data?.items ?? []
  return (
    <SectionPanel
      flush
      title="Connected clients"
      description="Each connection is one person through one client, acting with that person's permissions."
      actions={
        items.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost text-error"
            onClick={() => setConfirmAll(true)}
          >
            Revoke all
          </button>
        )
      }
    >
      {connections.isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={2} />
        </div>
      ) : connections.isError ? (
        <p className="px-5 pb-5 text-sm text-error" role="alert">
          Connections could not be loaded.
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          message="No clients connected"
          description="Connections appear here once someone connects a client with the URL above."
        />
      ) : (
        <McpConnectionsTable
          connections={items}
          show="person"
          revoking={revoke.isPending}
          onRevoke={(c, done) => revoke.mutate(c.id, { onSuccess: done })}
        />
      )}
      <ConfirmModal
        isOpen={confirmAll}
        title="Revoke every connection?"
        message={`All ${items.length} connected ${items.length === 1 ? 'client stops' : 'clients stop'} working on their next call. People can connect again.`}
        confirmText="Revoke all"
        confirmButtonClass="btn-error"
        isLoading={revokeAll.isPending}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => revokeAll.mutate(undefined, { onSuccess: () => setConfirmAll(false) })}
      />
    </SectionPanel>
  )
}

export default function McpSettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <ConnectionSection />
      <ConnectPolicySection />
      <ExposureSection />
      <ConnectedClientsSection />
    </div>
  )
}
