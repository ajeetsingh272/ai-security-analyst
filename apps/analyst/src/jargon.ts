/**
 * P4-07 AC1: "reports avoid unexplained jargon; any technical term is
 * glossed inline." `JARGON_GLOSSARY` is the blocklist AND the gloss
 * source in one place — a term can only be correctly glossed if its
 * own gloss text is defined here, so there is no way for the blocklist
 * (what `findUnglossedJargon` checks against) to drift out of sync with
 * what `glossJargon` actually knows how to explain.
 */
export const JARGON_GLOSSARY: Record<string, string> = {
  'oauth': 'a way apps get permission to access an account without a password',
  'inbox rule': 'an automatic mailbox setting that forwards or moves messages',
  'exfiltration': 'secretly copying data out of the organization',
  'lateral movement': 'moving from one compromised system to another inside the network',
  'phishing': 'a fake message designed to trick someone into giving up access',
  'credential stuffing': 'trying stolen username/password pairs on other accounts',
  'brute force': 'repeatedly guessing passwords until one works',
  'malware': 'software designed to damage or gain unauthorized access to a system',
  'c2': 'a remote system an attacker uses to control compromised machines',
  'command-and-control': 'a remote system an attacker uses to control compromised machines',
  'privilege escalation': 'gaining a higher level of access than originally granted',
  'mfa': 'a login step beyond a password, like a code sent to a phone',
  'vpn': 'a private, encrypted connection into a network',
  'ioc': 'a specific, observed sign that an attack is happening',
  'session hijacking': "taking over someone's already-logged-in session",
  'impersonation': 'pretending to be someone else to gain trust or access',
};

/** Longer phrases first, so "command-and-control" doesn't get
 * short-circuited by a shorter substring match that isn't in this
 * glossary at all. Word-boundary matching (not substring) so "mfa"
 * never matches inside an unrelated word. */
const TERMS_BY_LENGTH = Object.keys(JARGON_GLOSSARY).sort((a, b) => b.length - a.length);

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/** Glosses the FIRST occurrence of each jargon term in `text` with a
 * parenthetical plain-English explanation; later occurrences of the
 * same term are left alone, since a report that re-explains "OAuth"
 * every sentence reads worse than the jargon it's trying to avoid. */
export function glossJargon(text: string): string {
  let result = text;
  for (const term of TERMS_BY_LENGTH) {
    const pattern = termPattern(term);
    const match = pattern.exec(result);
    if (!match) continue;
    const matched = match[0];
    result = result.slice(0, match.index) + `${matched} (${JARGON_GLOSSARY[term]})` + result.slice(match.index + matched.length);
  }
  return result;
}

/** T2: "jargon detector finds no unglossed technical term from the
 * blocklist." A term counts as glossed if its own gloss text appears
 * within a short window after it — not merely "appears anywhere in the
 * document," which would let one early gloss silently cover every
 * later, un-related mention. */
export function findUnglossedJargon(text: string): string[] {
  const unglossed: string[] = [];
  for (const term of TERMS_BY_LENGTH) {
    const match = termPattern(term).exec(text);
    if (!match) continue; // the term doesn't appear at all — nothing to gloss
    const gloss = JARGON_GLOSSARY[term]!;
    const windowEnd = Math.min(text.length, match.index + match[0].length + gloss.length + 10);
    const window = text.slice(match.index, windowEnd);
    if (!window.includes(gloss)) {
      unglossed.push(term);
    }
  }
  return unglossed;
}
