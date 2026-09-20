/**
 * AI tab tidy — proposes folder groupings + tab closures for one Bit.
 *
 * PRIVACY: runs exclusively through ModelRouter.completeLocalOnly()
 * (Apple Foundation Models, then a downloaded local chat model). Cloud
 * providers are never consulted and tab URLs never leave the device.
 *
 * The model returns a plan; the renderer presents it for review and only
 * the user's explicitly confirmed actions are applied (see applyTidy).
 * Closed tabs are moved to the Archive, never destroyed.
 */

import type { Store } from './store';
import type { TabManager } from './tabs';
import type { ModelRouter } from './models/router';
import type { TidyActions, TidyCloseProposal, TidyGroupProposal, TidyPlan } from '../shared/ipc';

const SYSTEM = `You organize a web browser's open tabs into folders. Reply with ONLY a JSON object — no prose, no markdown fences, no commentary.

Shape:
{"groups":[{"name":"Folder name","tabIds":["id",...]}],"close":[{"tabId":"id","reason":"short reason"}]}

Rules:
- Group tabs by project or topic. A group needs at least 2 tabs; leave loners ungrouped.
- "close" is for: exact duplicate URLs (keep one), blank new-tab pages, and obvious accidental duplicates. Give a short plain-language reason for each.
- Stale tabs: you MAY also propose closing a tab idle 180+ minutes that is clearly a finished one-off read (news article, search results, docs page) — but only when the title/host makes it clearly disposable. When unsure, leave it open.
- Folder names: 1-3 words, Title Case, no emoji.
- Use the tab ids from the input EXACTLY. Never invent ids.
- Keep it tight: at most 8 groups, at most 20 closures.`;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Extract the first JSON object from model output (tolerates fences/prose). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a plan.');
  return JSON.parse(text.slice(start, end + 1));
}

export async function buildTidyPlan(
  store: Store,
  tabs: TabManager,
  router: ModelRouter,
  spaceId: string
): Promise<TidyPlan> {
  const space = store.d.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error('Bit not found.');
  const open = tabs.orderedTabs(spaceId).filter((t) => !t.pinned);
  if (open.length === 0) throw new Error('No open tabs to tidy in this Bit.');
  const validIds = new Set(open.map((t) => t.id));

  const lines = open.map((t) => {
    const idleMin = Math.max(0, Math.round((Date.now() - t.lastActive) / 60000));
    const folder = space.folders.find((f) => f.id === t.folderId)?.name ?? '-';
    const title = (t.title || t.url).replace(/\s+/g, ' ').trim().slice(0, 90);
    return `${t.id} | ${hostOf(t.url)} | ${title} | idle ${idleMin}m | folder: ${folder}`;
  });

  const user = `Open tabs in this workspace (id | site | title | idle time | current folder):\n${lines.join('\n')}\n\nPropose folder groupings and closures as JSON.`;

  const { text, via } = await router.completeLocalOnly({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user }
    ]
  });

  let parsed: { groups?: unknown; close?: unknown };
  try {
    parsed = extractJson(text) as { groups?: unknown; close?: unknown };
  } catch {
    throw new Error('The local model returned an unreadable plan — try again.');
  }

  const groups: TidyGroupProposal[] = [];
  if (Array.isArray(parsed.groups)) {
    for (const g of parsed.groups) {
      const name = String((g as { name?: unknown }).name ?? '').trim().slice(0, 40);
      const ids = Array.isArray((g as { tabIds?: unknown }).tabIds)
        ? ((g as { tabIds: unknown[] }).tabIds.map(String).filter((id) => validIds.has(id)))
        : [];
      const unique = [...new Set(ids)];
      if (name && unique.length >= 2) groups.push({ name, tabIds: unique });
      if (groups.length >= 8) break;
    }
  }

  const close: TidyCloseProposal[] = [];
  const grouped = new Set(groups.flatMap((g) => g.tabIds));
  if (Array.isArray(parsed.close)) {
    for (const c of parsed.close) {
      const tabId = String((c as { tabId?: unknown }).tabId ?? '');
      const reason = String((c as { reason?: unknown }).reason ?? '').trim().slice(0, 120) || 'Suggested by tidy';
      if (validIds.has(tabId) && !grouped.has(tabId) && !close.some((x) => x.tabId === tabId)) {
        close.push({ tabId, reason });
      }
      if (close.length >= 20) break;
    }
  }

  if (groups.length === 0 && close.length === 0) {
    throw new Error('The local model found nothing worth tidying — your tabs already look organized.');
  }
  return { groups, close, via };
}

/**
 * Apply the user's CONFIRMED actions. New folders are created, tabs are
 * filed, and closed tabs are moved to the Archive (restorable).
 */
export function applyTidy(
  store: Store,
  tabs: TabManager,
  spaceId: string,
  actions: TidyActions
): void {
  const space = store.d.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error('Bit not found.');

  for (const g of actions.newFolders ?? []) {
    const name = String(g.name ?? '').trim().slice(0, 40);
    const ids = [...new Set((g.tabIds ?? []).map(String))];
    if (!name || ids.length === 0) continue;
    const folder = store.addFolder(spaceId, name);
    for (const id of ids) {
      const t = tabs.tabs.get(id);
      if (t && t.spaceId === spaceId && !t.pinned) tabs.setFolder(id, folder.id);
    }
  }

  for (const id of new Set((actions.closeTabIds ?? []).map(String))) {
    const t = tabs.tabs.get(id);
    if (t && t.spaceId === spaceId && !t.pinned) tabs.archive(id, true);
  }
}
