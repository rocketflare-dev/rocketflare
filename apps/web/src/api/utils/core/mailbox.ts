/**
 * The mailbox an address delivers to, for counting mail per recipient: lower-cased, a `+tag` on the
 * local part removed, and for Gmail (`gmail.com`, `googlemail.com` — one domain) the dots in the
 * local part removed too, since Gmail ignores them. Only a KEY: mail still goes to the address as
 * typed. A local part that is nothing but a tag is left whole.
 */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function canonicalMailbox(email: string): string {
  const lower = email.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  if (at <= 0) return lower
  let local = lower.slice(0, at)
  let domain = lower.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com'
    local = local.replace(/\./g, '') || local
  }
  return `${local}@${domain}`
}
