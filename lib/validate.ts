import { isIP } from 'node:net';

// -----------------------------------------------------------------------------
// Webhook URL validation -- SSRF defence in depth.
//
// Anyone can call POST /api/subscriptions with any URL. Without validation a
// caller could register a subscription pointing at:
//   - http://localhost / 127.0.0.1   -> probe local services on the worker host
//   - http://169.254.169.254/        -> AWS / GCP instance metadata (IAM creds)
//   - http://10.x / 192.168.x        -> internal corp networks reachable from
//                                       wherever the worker runs
// ...and use the worker as an SSRF (server-side request forgery) tool.
//
// We reject the obvious cases at registration time:
//   1. Anything that's not a syntactically valid URL.
//   2. Anything that isn't https:// (no plaintext, no exotic schemes).
//   3. Any URL whose hostname is an IP literal in a private / loopback /
//      link-local / multicast range (IPv4 or IPv6, including v4-mapped).
//
// IMPORTANT LIMITATION: this does NOT defeat DNS rebinding. An attacker can
// register https://attacker.com (passes validation) and then point DNS at
// 169.254.169.254 between validation and delivery. Full mitigation requires
// resolving the host at delivery time and re-checking the resolved IP, plus
// pinning the connection to that IP for the entire request. That's too
// invasive for a portfolio project; called out in the README as future work.
// -----------------------------------------------------------------------------

export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid_url' }
  | { ok: false; reason: 'protocol_not_https'; protocol: string }
  | { ok: false; reason: 'private_ip_blocked'; host: string };

export function validateWebhookUrl(input: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'protocol_not_https', protocol: url.protocol };
  }

  // URL.hostname strips the [ ] around IPv6 literals, so isIP can read it
  // directly. Returns 4 / 6 for IP literals, 0 for hostnames.
  const host = url.hostname;
  const kind = isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) {
    return { ok: false, reason: 'private_ip_blocked', host };
  }
  if (kind === 6 && isPrivateIPv6(host)) {
    return { ok: false, reason: 'private_ip_blocked', host };
  }

  return { ok: true, url };
}

// -----------------------------------------------------------------------------
// IPv4 range checks
//
// We block the unicast-private and special-use ranges from IANA's IPv4 Special-
// Purpose Address Registry. Hand-rolled (no `ipaddr.js` dep) because the rules
// are short, well-known, and reading them in source is a recruiter signal.
// -----------------------------------------------------------------------------
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map((s) => Number.parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return true; // unparseable -> treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true;                        // 0.0.0.0/8       this-network
  if (a === 10) return true;                       // 10.0.0.0/8      RFC1918
  if (a === 127) return true;                      // 127.0.0.0/8     loopback
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16  link-local (incl. AWS / GCP IMDS at 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12  RFC1918
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16  RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                       // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast

  return false;
}

// -----------------------------------------------------------------------------
// IPv6 range checks
//
// Coverage:
//   ::          (unspecified)
//   ::1         (loopback)
//   fc00::/7    unique-local        (matches fc.. and fd..)
//   fe80::/10   link-local          (matches fe8x..feb)
//   ff00::/8    multicast           (matches ff..)
//   ::ffff:V4   v4-mapped -- unwrap and re-check via isPrivateIPv4
//
// Conservative on edge cases: anything we can't parse cleanly is treated as
// unsafe. Rejecting too much is recoverable (the user fixes their URL); a
// false negative here is an SSRF.
// -----------------------------------------------------------------------------
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  if (lower === '::' || lower === '::1') return true;

  // ::ffff:1.2.3.4 -- IPv4 wrapped in IPv6 syntax. Unwrap and re-check.
  const v4mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]!);

  // First hextet checks. A normalised IPv6 address always has the first
  // hextet before the first ':'.
  const firstHextet = lower.split(':')[0] ?? '';

  // ff00::/8 multicast -- any address whose first hextet starts with "ff".
  if (firstHextet.startsWith('ff')) return true;

  // fc00::/7 unique-local -- first byte 0xfc or 0xfd, i.e. first hextet
  // starts with "fc" or "fd".
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true;

  // fe80::/10 link-local -- first hextet 0xfe80..0xfebf. The high 10 bits are
  // 1111111010, so the first hextet is fe80, fe81, ..., feb f.
  if (/^fe[89ab]/.test(firstHextet)) return true;

  return false;
}
