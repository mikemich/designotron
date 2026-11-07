// Which hosts a relay can be on: this computer, or a local network. Pure, so it can be tested.

/** A host on this computer or its local network: localhost, 127/8, [::1], 10/8, 172.16/12,
 *  192.168/16 and `*.local`. `host` is a URL hostname (IPv6 in brackets). */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Only this computer can open it: localhost, 127/8 and [::1] (a LAN address can be reached by others). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "[::1]" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
