export function fileDiffElement(item, loadDiff) {
  const card = document.createElement("details"); card.className = "tool-card file-changes";
  const heading = document.createElement("summary");
  heading.textContent = `文件修改 · ${item.status || "处理中"} · ${(item.changes || []).length} 个文件`;
  card.append(heading);
  for (const [index, initial] of (item.changes || []).entries()) {
    const file = document.createElement("details"); file.className = "file-diff";
    const title = document.createElement("summary");
    const kind = initial.kind?.type || initial.kind;
    title.textContent = `${({ add: "新增", delete: "删除", update: "修改" })[kind] || "修改"} · ${initial.path || initial.file || "文件"}`;
    const body = document.createElement("div"); file.append(title, body);
    let loaded = false, loading = false;
    const render = (change) => {
      body.replaceChildren();
      const pre = document.createElement("pre"); pre.className = "diff-lines";
      if (!change.diff) pre.textContent = "此条记录未提供差异内容。";
      else for (const line of change.diff.split("\n")) {
        const span = document.createElement("span");
        span.className = line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : line.startsWith("@@") ? "diff-hunk" : "diff-context";
        span.textContent = line || " "; pre.append(span);
      }
      body.append(pre);
      if (change.diffTruncated) {
        const notice = document.createElement("p"); notice.textContent = "差异较长，已达到显示上限；完整内容请在电脑查看。"; body.append(notice);
      }
    };
    const load = async () => {
      if (!file.open || loaded || loading) return;
      loading = true;
      try {
        body.textContent = "正在读取差异…";
        render(initial.diff === undefined && loadDiff ? await loadDiff(index) : initial);
        loaded = true;
      } catch (error) {
        body.textContent = error.message;
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试读取差异"; retry.onclick = load; body.append(retry);
      } finally { loading = false; }
    };
    file.addEventListener("toggle", load);
    card.append(file);
  }
  return card;
}
