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

/** The links an online owner gets for a room on `relay` (an origin without a trailing slash).
 *  `here` is this editor's own address, `pageLocal` whether it runs on localhost, `own` whether the
 *  relay serves this very page, `editor` whether the relay serves an editor and `hosted` the editor
 *  that localhost pages use for guests. A relay on this computer or the local network that serves an
 *  editor gets its own link; without an editor the link opens this editor, pointed at the relay. */
export function linkFor(a: { relay: string; room: string; here: string; pageLocal: boolean; own: boolean; editor: boolean; hosted: string }): { link: string; previewLink: string | null; localOnly: boolean } {
  const query = a.own ? `?room=${a.room}` : `?room=${a.room}&relay=${encodeURIComponent(a.relay)}`;
  const relayLocal = isLocalHost(new URL(a.relay).hostname);
  const mine = `${a.here}${query}`;
  const link = relayLocal && a.editor && !a.own ? `${a.relay}/?room=${a.room}` : `${a.own || !a.pageLocal || relayLocal ? a.here : a.hosted}${query}`;
  return { link, previewLink: link === mine ? null : mine, localOnly: isLoopbackHost(new URL(link).hostname) };
}
