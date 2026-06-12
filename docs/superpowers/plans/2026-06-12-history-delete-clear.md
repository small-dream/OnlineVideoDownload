# Download History Delete & Clear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add single-record deletion to download history, with a delete button on each row in the Options page History tab.

**Architecture:** Add `deleteRecord(id)` to `DownloadHistoryStore`, a new `DELETE_DOWNLOAD_HISTORY_RECORD` message type routed through the service worker, and a delete icon button per row in the Options page history table.

**Tech Stack:** Chrome Extension MV3, ES Modules (background), IIFE (lib/options), `node:test` + `node:assert/strict`

---

## Files

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `background/download-history-store.js` | Add `deleteRecord(id)` method |
| Modify | `test/download-history-store.test.js` | Add tests for `deleteRecord` |
| Modify | `lib/message-types.js` | Add `DELETE_DOWNLOAD_HISTORY_RECORD` constant |
| Modify | `background/service-worker.js` | Route new message to `historyStore.deleteRecord()` |
| Modify | `options/options.html` | Add "操作" column header, add data-id attribute to rows |
| Modify | `options/options.js` | Render delete button per row, handle click, send delete message |
| Modify | `options/options.css` | Style delete button and action column |
| Modify | `docs/PRD.md` | Update §4.9 with delete capability |
| Modify | `docs/ARCHITECTURE.md` | Update Download History Store public surface, message model |

---

### Task 1: Store — Add `deleteRecord(id)` with tests

**Files:**
- Modify: `background/download-history-store.js:99-102` (after `clear()` method)
- Modify: `test/download-history-store.test.js` (append tests at end)

- [ ] **Step 1: Write failing tests for `deleteRecord`**

Append to `test/download-history-store.test.js`:

```javascript
test('deleteRecord removes a record by id', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: 'a', title: 'Keep' });
  await store.addRecord({ id: 'b', title: 'Delete' });
  await store.addRecord({ id: 'c', title: 'Also Keep' });

  await store.deleteRecord('b');

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'c');
  assert.equal(records[1].id, 'a');
});

test('deleteRecord persists after deletion', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: 'x', title: 'To Delete' });
  await store.addRecord({ id: 'y', title: 'To Keep' });

  await store.deleteRecord('x');

  const stored = globalThis.chrome.storage.local._data['ovd.downloadHistory'];
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].id, 'y');
});

test('deleteRecord is no-op when id not found', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: '1', title: 'Exists' });

  await store.deleteRecord('nonexistent');

  const records = await store.getAll();
  assert.equal(records.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/download-history-store.test.js`
Expected: 3 FAIL — `store.deleteRecord is not a function`

- [ ] **Step 3: Implement `deleteRecord`**

In `background/download-history-store.js`, after the `clear()` method (after line 102), add:

```javascript

  async deleteRecord(id) {
    const before = this._records.length;
    this._records = this._records.filter((r) => r.id !== id);
    if (this._records.length < before) {
      await this._persist();
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/download-history-store.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add background/download-history-store.js test/download-history-store.test.js
git commit -m "feat: add deleteRecord(id) to DownloadHistoryStore"
```

---

### Task 2: Message type and service worker routing

**Files:**
- Modify: `lib/message-types.js:37` (after `OPEN_DOWNLOAD_FOLDER` line)
- Modify: `background/service-worker.js:387` (after `CLEAR_DOWNLOAD_HISTORY` case)

- [ ] **Step 1: Add message constant**

In `lib/message-types.js`, after the `OPEN_DOWNLOAD_FOLDER` line (line 37), add:

```javascript
    DELETE_DOWNLOAD_HISTORY_RECORD: 'DELETE_DOWNLOAD_HISTORY_RECORD',
```

- [ ] **Step 2: Add service worker case**

In `background/service-worker.js`, after the `CLEAR_DOWNLOAD_HISTORY` case block (after line 386), add:

```javascript

    case MSG.DELETE_DOWNLOAD_HISTORY_RECORD || 'DELETE_DOWNLOAD_HISTORY_RECORD':
      await historyStore.deleteRecord(msg.id);
      return { ok: true };
```

- [ ] **Step 3: Commit**

```bash
git add lib/message-types.js background/service-worker.js
git commit -m "feat: add DELETE_DOWNLOAD_HISTORY_RECORD message type and routing"
```

---

### Task 3: Options UI — Delete button per row

**Files:**
- Modify: `options/options.html:132-138` (thead columns)
- Modify: `options/options.js:231-271` (renderHistory function)
- Modify: `options/options.css:430-432` (after col-status styles)

- [ ] **Step 1: Add "操作" column header in HTML**

In `options/options.html`, replace the `<thead>` block (lines 132-138) with:

```html
        <thead>
          <tr>
            <th class="col-title">标题</th>
            <th class="col-type">类型</th>
            <th class="col-size">大小</th>
            <th class="col-date">日期</th>
            <th class="col-status">状态</th>
            <th class="col-action">操作</th>
          </tr>
        </thead>
```

- [ ] **Step 2: Add action column CSS**

In `options/options.css`, after the `.col-status` block (after line 432), add:

```css

.col-action {
  width: 50px;
  text-align: center;
}

.btn-delete-record {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}

.btn-delete-record:hover {
  color: #ff6b81;
  background: rgba(255, 107, 129, 0.1);
}
```

- [ ] **Step 3: Update `renderHistory` to add delete button per row**

In `options/options.js`, replace the `renderHistory` function's `items.forEach` block (lines 231-271) with:

```javascript
    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.dataset.id = item.id;

      const rawName = (item.title || item.filename || '');
      const displayName = rawName ? rawName.split(/[\\/]/).pop() : '未知视频';
      const title = escapeHtml ? escapeHtml(displayName) : displayName;

      const typeLabel = getVideoTypeLabel
        ? getVideoTypeLabel(item.type || item.videoType)
        : (item.type || item.videoType || 'VIDEO');

      const typeClass = 'type-' + (item.type || item.videoType || 'direct').replace(/[^a-z-]/g, '');

      const sizeText = formatSize
        ? formatSize(item.fileSize || item.size || 0)
        : (item.fileSize || item.size ? String(item.fileSize || item.size) : '-');

      const dateText = formatDate(item.date || item.timestamp || item.downloadDate);

      const statusText = getStatusText(item.status || item.state);
      const statusClass = 'status-' + getStatusClass(item.status || item.state);
      const downloadId = item.downloadId;

      if (downloadId != null) {
        tr.classList.add('history-row-clickable');
        tr.title = '点击打开下载文件所在文件夹';
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.btn-delete-record')) return;
          openDownloadFolder(downloadId);
        });
      }

      tr.innerHTML = `
        <td class="col-title-cell" title="${title}">${title}</td>
        <td><span class="type-badge ${typeClass}">${typeLabel}</span></td>
        <td>${sizeText || '-'}</td>
        <td>${dateText}</td>
        <td class="${statusClass}">${statusText}</td>
        <td class="col-action"></td>
      `;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-delete-record';
      deleteBtn.title = '删除';
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteHistoryRecord(item.id, tr);
      });
      tr.querySelector('.col-action').appendChild(deleteBtn);

      historyBody.appendChild(tr);
    });
```

- [ ] **Step 4: Add `deleteHistoryRecord` helper function**

In `options/options.js`, after the `openDownloadFolder` function (after line 291), add:

```javascript

  async function deleteHistoryRecord(recordId, rowElement) {
    try {
      const response = await sendBackgroundMessage({
        type: MSG.DELETE_DOWNLOAD_HISTORY_RECORD || 'DELETE_DOWNLOAD_HISTORY_RECORD',
        id: recordId,
      });

      if (!response || response.ok === false) {
        showHistoryFeedback('删除失败');
        return;
      }

      rowElement.remove();

      const remaining = historyBody.querySelectorAll('tr').length;
      if (historyCountEl) historyCountEl.textContent = `共 ${remaining} 条记录`;

      if (remaining === 0) {
        if (historyTable) historyTable.hidden = true;
        if (historyEmpty) historyEmpty.hidden = false;
      }
    } catch (err) {
      console.warn('[OVD] failed to delete history record:', err);
      showHistoryFeedback('删除失败');
    }
  }
```

- [ ] **Step 5: Commit**

```bash
git add options/options.html options/options.js options/options.css
git commit -m "feat: add per-row delete button to download history"
```

---

### Task 4: Update documentation

**Files:**
- Modify: `docs/PRD.md:142-152` (§4.9 下载历史)
- Modify: `docs/ARCHITECTURE.md:479-519` (Download History Store section + message model)

- [ ] **Step 1: Update PRD §4.9**

In `docs/PRD.md`, update the 下载历史 section. Replace lines 142-152 with:

```markdown
### 4.9 下载历史

- 使用 `chrome.storage.local` 持久化下载记录
- 最多保留 100 条历史记录
- 每条记录包含标题、URL、下载时间、文件大小、下载 ID 等信息
- 支持按保留天数自动清理过期记录
- 支持手动清除全部历史
- 支持删除单条历史记录（每行右侧删除按钮）
- 在 Options Page 的 History 标签页中展示
- 下载完成时自动写入历史记录
- 新增记录时自动去重合并：按 `downloadId`、文件路径、URL + 时间窗口（2 分钟内）、CJK 相似标题匹配检测重复，合并为同一条记录
- 历史记录支持点击打开下载文件所在文件夹（需要该记录包含浏览器下载 ID）
```

Update the version at line 4 to `1.12.0`, the date to `2026-06-12`.

Add a row to the version history table:

```markdown
| 1.12.0 | 2026-06-12 | 下载历史支持单条删除（每行右侧删除按钮）和清空全部历史。 |
```

- [ ] **Step 2: Update ARCHITECTURE.md**

Update the version at line 3 to `1.12.0`, date to `2026-06-12`.

In the Download History Store public surface (around line 519), add `deleteRecord(id)`:

```markdown
- `init()`
- `addRecord(record)`
- `getAll()`
- `deleteRecord(id)`
- `clear()`
- `prune()`
```

In the Content -> Background message examples (around line 558), add `DELETE_DOWNLOAD_HISTORY_RECORD` to the list.

Add a row to the version history table:

```markdown
| 1.11.1 | 2026-06-12 | Added single-record deletion for download history (`deleteRecord`, `DELETE_DOWNLOAD_HISTORY_RECORD` message type, per-row delete button in Options). |
```

- [ ] **Step 3: Commit**

```bash
git add docs/PRD.md docs/ARCHITECTURE.md
git commit -m "docs: update PRD and ARCHITECTURE for history delete feature"
```

---

### Task 5: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests PASS (including the 3 new `deleteRecord` tests)

- [ ] **Step 2: Verify no regressions**

Confirm total test count includes the 3 new tests and no existing tests broke.
