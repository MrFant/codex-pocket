export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_WINDOW_SIZE = 200;
export const itemCursor = (turnId, itemId) => JSON.stringify([String(turnId), String(itemId)]);
const invalid = () => Object.assign(new Error("历史分页参数无效"), { status: 400 });

export function withoutDiff(item) {
  if (item.type !== "fileChange") return item;
  return { ...item, changes: (item.changes || []).map(({ diff, ...change }) => ({ ...change, diffAvailable: Boolean(diff) })) };
}

export function historyPage(result, query) {
  if (!query.has("limit")) return result; // Existing clients keep their read contract.
  const limit = Number(query.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_WINDOW_SIZE) throw invalid();
  const directions = ["before", "after", "around"].filter((key) => query.has(key));
  if (directions.length > 1) throw invalid();
  const entries = (result.thread?.turns || []).flatMap((turn) => (turn.items || []).map((item) => ({ turn, item, cursor: itemCursor(turn.id, item.id) })));
  let end = entries.length;
  let start = Math.max(0, end - limit);
  const direction = directions[0];
  let anchorFound = true;
  if (direction) {
    const cursor = query.get(direction);
    if (cursor.length > 4096) throw invalid();
    const index = entries.findIndex((entry) => entry.cursor === cursor || (direction === "around" && entry.item.id === cursor));
    anchorFound = index >= 0;
    if (!anchorFound && direction !== "around") throw Object.assign(new Error("历史位置已变化，请重新同步会话"), { status: 409, code: "history_cursor_missing" });
    if (index >= 0) {
      if (direction === "before") { end = index; start = Math.max(0, end - limit); }
      if (direction === "after") { start = index + 1; end = Math.min(entries.length, start + limit); }
      if (direction === "around") {
        start = Math.max(0, Math.min(index - Math.floor(limit / 2), entries.length - limit));
        end = Math.min(entries.length, start + limit);
      }
    }
  }
  const selected = entries.slice(start, end);
  const turns = [];
  for (const entry of selected) {
    if (turns.at(-1)?.id !== entry.turn.id) turns.push({ ...entry.turn, items: [] });
    turns.at(-1).items.push({ ...withoutDiff(entry.item), historyCursor: entry.cursor });
  }
  return { ...result, thread: { ...result.thread, turns }, history: {
    totalCount: entries.length, hasEarlier: start > 0, hasLater: end < entries.length,
    beforeCursor: selected[0]?.cursor || null, afterCursor: selected.at(-1)?.cursor || null, anchorFound,
  } };
}
