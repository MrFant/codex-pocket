export const MAX_VISIBLE_ITEMS = 200;
export const flattenHistory = (thread) => (thread.turns || []).flatMap((turn) => (turn.items || []).filter((item) => item && !["reasoning", "hookPrompt", "contextCompaction"].includes(item.type)).map((item) => ({ ...item, turnId: turn.id,
  historyCursor: item.historyCursor || JSON.stringify([String(turn.id), String(item.id)]),
})));

export function mergeHistory(current, page, direction) {
  const additions = flattenHistory(page.thread);
  const all = direction === "before" ? [...additions, ...current.items] : [...current.items, ...additions];
  const unique = [...new Map(all.map((item) => [item.historyCursor, item])).values()];
  const trimmed = unique.length > MAX_VISIBLE_ITEMS;
  const items = direction === "before" ? unique.slice(0, MAX_VISIBLE_ITEMS) : unique.slice(-MAX_VISIBLE_ITEMS);
  return { items, history: {
    totalCount: page.history?.totalCount ?? current.history?.totalCount,
    hasEarlier: direction === "before" ? Boolean(page.history?.hasEarlier) : trimmed || Boolean(current.history?.hasEarlier),
    hasLater: direction === "after" ? Boolean(page.history?.hasLater) : trimmed || Boolean(current.history?.hasLater),
    beforeCursor: items[0]?.historyCursor, afterCursor: items.at(-1)?.historyCursor,
  } };
}

export function threadWithItems(thread, items) {
  const turns = [];
  const metadata = new Map((thread.turns || []).map((turn) => [turn.id, turn]));
  for (const item of items) {
    if (turns.at(-1)?.id !== item.turnId) turns.push({ ...metadata.get(item.turnId), id: item.turnId, items: [] });
    turns.at(-1).items.push(item);
  }
  return { ...thread, turns };
}
