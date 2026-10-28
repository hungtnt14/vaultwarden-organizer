/*
 * VWCore — pure data logic (no DOM). Loaded by the browser app and by the Node tests.
 *
 * Internal model:
 *   state = { mode: 'org'|'personal', orgId, meta, cols: [{id, name, ...}], items: [...] }
 *   - cols are Bitwarden collections (org export) or folders (personal export);
 *     nesting is encoded in the name with "/" (e.g. "Infra/HCM/Server").
 *   - every item carries membership in item.collectionIds (array), in both modes.
 */
(function (root) {
  'use strict';

  const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  const cmp = (a, b) => collator.compare(a, b);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const nowIso = () => new Date().toISOString();

  function uuid() {
    const c = root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (c.randomUUID) return c.randomUUID();
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  function normName(name) {
    const n = String(name ?? '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
    return n || '(không tên)';
  }
  const parentName = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null);
  const leafName = (name) => name.slice(name.lastIndexOf('/') + 1);
  const joinName = (parent, leaf) => (parent ? `${parent}/${leaf}` : leaf);

  const colById = (s, id) => s.cols.find((c) => c.id === id) || null;
  const colByName = (s, name) => s.cols.find((c) => c.name === name) || null;
  const itemById = (s, id) => s.items.find((i) => i.id === id) || null;
  const isSelfOrDescendant = (ancestorName, name) => name === ancestorName || name.startsWith(ancestorName + '/');

  // ---------------------------------------------------------------- import

  function parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('File không phải JSON hợp lệ: ' + e.message);
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      throw new Error('Không thấy mảng "items" — đây có phải file export JSON của Bitwarden/Vaultwarden không?');
    }
    if (data.encrypted) {
      throw new Error('File đang được mã hóa. Hãy export lại với định dạng ".json" (không mã hóa).');
    }

    const mode = Array.isArray(data.collections) ? 'org' : 'personal';
    const meta = {};
    for (const k of Object.keys(data)) if (!['items', 'collections', 'folders'].includes(k)) meta[k] = data[k];

    const src = (mode === 'org' ? data.collections : data.folders) || [];
    const cols = src.map((c) => ({ ...c, id: c.id || uuid(), name: normName(c.name) }));
    const ids = new Set(cols.map((c) => c.id));
    const orgId =
      (mode === 'org' && (cols.find((c) => c.organizationId)?.organizationId ||
        data.items.find((i) => i.organizationId)?.organizationId)) || null;

    let dangling = 0;
    const items = data.items.map((raw) => {
      const it = clone(raw);
      if (!it.id) it.id = uuid();
      const memb = mode === 'org' ? it.collectionIds || [] : it.folderId ? [it.folderId] : [];
      it.collectionIds = memb.filter((id) => ids.has(id) || (dangling++, false));
      return it;
    });

    const state = { mode, orgId, meta, cols, items };
    const addedParents = ensureParents(state);
    return { state, report: { dangling, addedParents } };
  }

  /** Make sure every intermediate path ("A", "A/B" for "A/B/C") exists as a collection. */
  function ensureParents(s) {
    const names = new Set(s.cols.map((c) => c.name));
    let added = 0;
    for (const c of [...s.cols]) {
      let p = parentName(c.name);
      while (p !== null && !names.has(p)) {
        s.cols.push(newCol(s, p));
        names.add(p);
        added++;
        p = parentName(p);
      }
    }
    return added;
  }

  function newCol(s, name) {
    return s.mode === 'org'
      ? { id: uuid(), organizationId: s.orgId, name, externalId: null }
      : { id: uuid(), name };
  }

  // ---------------------------------------------------------------- tree

  function buildTree(s) {
    const nodes = new Map();
    const byName = new Map();
    for (const c of s.cols) {
      const n = { col: c, children: [], items: [], total: 0 };
      nodes.set(c.id, n);
      if (!byName.has(c.name)) byName.set(c.name, n);
    }
    const roots = [];
    for (const n of nodes.values()) {
      const p = parentName(n.col.name);
      const pn = p !== null ? byName.get(p) : null;
      (pn && pn !== n ? pn.children : roots).push(n);
    }
    const unassigned = [];
    for (const it of s.items) {
      let placed = false;
      for (const id of it.collectionIds) {
        const n = nodes.get(id);
        if (n) {
          n.items.push(it);
          placed = true;
        }
      }
      if (!placed) unassigned.push(it);
    }
    const byItem = (a, b) => cmp(a.name || '', b.name || '');
    const byLeaf = (a, b) => cmp(leafName(a.col.name), leafName(b.col.name));
    const finish = (n) => {
      n.children.sort(byLeaf);
      n.items.sort(byItem);
      n.total = n.items.length + n.children.reduce((sum, c) => sum + finish(c), 0);
      return n.total;
    };
    roots.sort(byLeaf).forEach(finish);
    unassigned.sort(byItem);
    return { roots, nodes, unassigned };
  }

  function itemMatches(it, q) {
    if (!q) return true;
    const hay = [it.name, it.notes, it.login?.username, ...(it.login?.uris || []).map((u) => u.uri)];
    return hay.some((v) => v && String(v).toLowerCase().includes(q));
  }

  // ---------------------------------------------------------------- collection ops

  /** Collections that are `col` itself or nested below it. */
  function subtree(s, col) {
    return s.cols.filter((c) => c === col || c.name.startsWith(col.name + '/'));
  }

  /** Where would `colId` end up if moved under `newParentId` (null = top level)? */
  function planMoveCollection(s, colId, newParentId) {
    const col = colById(s, colId);
    const parent = newParentId ? colById(s, newParentId) : null;
    if (!col || (newParentId && !parent)) return { error: 'Collection không tồn tại' };
    if (parent && isSelfOrDescendant(col.name, parent.name)) {
      return { error: 'Không thể chuyển collection vào chính nó hoặc collection con của nó' };
    }
    const newName = joinName(parent ? parent.name : null, leafName(col.name));
    const conflict = s.cols.find((c) => c.name === newName && c !== col) || null;
    return { newName, conflict, noop: newName === col.name };
  }

  function planRenameCollection(s, colId, newLeaf) {
    const col = colById(s, colId);
    const leaf = String(newLeaf ?? '').trim();
    if (!col) return { error: 'Collection không tồn tại' };
    if (!leaf) return { error: 'Tên không được để trống' };
    if (leaf.includes('/')) return { error: 'Tên không được chứa "/" (dùng kéo thả để lồng cấp)' };
    const newName = joinName(parentName(col.name), leaf);
    const conflict = s.cols.find((c) => c.name === newName && c !== col) || null;
    return { newName, conflict, noop: newName === col.name };
  }

  /**
   * Rename `colId` (and everything nested under it) to `newName`.
   * Collections that land on an existing name are merged into the existing one.
   * Returns the id of the collection now holding `newName`.
   */
  function renameSubtree(s, colId, newName) {
    const col = colById(s, colId);
    const old = col.name;
    if (old === newName) return col.id;
    const moved = subtree(s, col);
    const movedSet = new Set(moved);
    for (const c of moved) c.name = newName + c.name.slice(old.length);
    mergeInto(s, moved, movedSet);
    ensureParents(s);
    return colByName(s, newName).id;
  }

  function mergeInto(s, moved, movedSet) {
    for (const c of moved) {
      const target = s.cols.find((o) => o.name === c.name && !movedSet.has(o));
      if (!target) continue;
      for (const it of s.items) {
        if (!it.collectionIds.includes(c.id)) continue;
        it.collectionIds = [...new Set(it.collectionIds.map((id) => (id === c.id ? target.id : id)))];
      }
      s.cols = s.cols.filter((x) => x !== c);
    }
  }

  function addCollection(s, parentId, leaf) {
    const parent = parentId ? colById(s, parentId) : null;
    const base = String(leaf || 'Collection mới').replace(/\//g, '-').trim() || 'Collection mới';
    let name = joinName(parent?.name, base);
    for (let i = 2; colByName(s, name); i++) name = joinName(parent?.name, `${base} (${i})`);
    const col = newCol(s, name);
    s.cols.push(col);
    return col;
  }

  /** Remove the collection but keep its content: sub-collections and items move up one level. */
  function dissolveCollection(s, colId) {
    const col = colById(s, colId);
    const pName = parentName(col.name);
    const parent = pName !== null ? colByName(s, pName) : null;
    const prefix = col.name + '/';
    const moved = s.cols.filter((c) => c.name.startsWith(prefix));
    for (const c of moved) c.name = joinName(pName, c.name.slice(prefix.length));
    for (const it of s.items) {
      if (!it.collectionIds.includes(col.id)) continue;
      const next = it.collectionIds.filter((id) => id !== col.id);
      if (parent && !next.includes(parent.id)) next.push(parent.id);
      it.collectionIds = next;
    }
    s.cols = s.cols.filter((c) => c !== col);
    mergeInto(s, moved, new Set(moved));
    return parent ? parent.id : null;
  }

  /** Remove the collection, its sub-collections, and items that belong nowhere else. */
  function deleteCollectionTree(s, colId) {
    const col = colById(s, colId);
    const gone = new Set(subtree(s, col).map((c) => c.id));
    let deletedItems = 0;
    s.items = s.items.filter((it) => {
      const before = it.collectionIds.length;
      it.collectionIds = it.collectionIds.filter((id) => !gone.has(id));
      const keep = !(before > 0 && it.collectionIds.length === 0);
      if (!keep) deletedItems++;
      return keep;
    });
    s.cols = s.cols.filter((c) => !gone.has(c.id));
    return { deletedCols: gone.size, deletedItems };
  }

  function collectionStats(s, colId) {
    const col = colById(s, colId);
    const sub = subtree(s, col);
    const subIds = new Set(sub.map((c) => c.id));
    const direct = s.items.filter((i) => i.collectionIds.includes(colId)).length;
    const inTree = s.items.filter((i) => i.collectionIds.some((id) => subIds.has(id)));
    const onlyHere = inTree.filter((i) => i.collectionIds.every((id) => subIds.has(id))).length;
    const childCols = s.cols.filter((c) => parentName(c.name) === col.name).length;
    return { direct, childCols, descendants: sub.length - 1, inTree: inTree.length, onlyHere };
  }

  // ---------------------------------------------------------------- item ops

  /**
   * moves: [{itemId, fromColId}] — fromColId is the collection the row was dragged from.
   * copy (org only): add membership instead of moving.
   * toColId null = drop into "no collection".
   */
  function moveItems(s, moves, toColId, copy) {
    let changed = 0;
    for (const { itemId, fromColId } of moves) {
      const it = itemById(s, itemId);
      if (!it) continue;
      const before = JSON.stringify(it.collectionIds);
      let ids = [...it.collectionIds];
      if (s.mode === 'personal') {
        ids = toColId ? [toColId] : [];
      } else if (!toColId) {
        ids = fromColId ? ids.filter((id) => id !== fromColId) : [];
      } else {
        if (!copy && fromColId) ids = ids.filter((id) => id !== fromColId);
        if (!ids.includes(toColId)) ids.push(toColId);
      }
      it.collectionIds = ids;
      if (JSON.stringify(ids) !== before) {
        changed++;
        touch(it);
      }
    }
    return changed;
  }

  function newItem(s, type, colId) {
    const now = nowIso();
    const it = {
      type,
      name: type === 2 ? 'Ghi chú mới' : 'Item mới',
      favorite: false,
      reprompt: 0,
      id: uuid(),
      organizationId: s.mode === 'org' ? s.orgId : null,
      collectionIds: colId ? [colId] : [],
      notes: null,
      fields: [],
      passwordHistory: [],
      creationDate: now,
      revisionDate: now,
    };
    if (type === 1) it.login = { uris: [], username: '', password: '', totp: null, fido2Credentials: [] };
    if (type === 2) it.secureNote = { type: 0 };
    s.items.push(it);
    return it;
  }

  function duplicateItem(s, itemId) {
    const src = itemById(s, itemId);
    const it = clone(src);
    it.id = uuid();
    it.name = `${src.name || ''} (bản sao)`;
    it.creationDate = it.revisionDate = nowIso();
    if (it.login) it.login.fido2Credentials = [];
    s.items.splice(s.items.indexOf(src) + 1, 0, it);
    return it;
  }

  function deleteItems(s, itemIds) {
    const set = new Set(itemIds);
    const before = s.items.length;
    s.items = s.items.filter((i) => !set.has(i.id));
    return before - s.items.length;
  }

  function touch(it) {
    it.revisionDate = nowIso();
  }

  // ---------------------------------------------------------------- export

  function exportData(s, { format = s.mode, newIds = true } = {}) {
    const idMap = new Map(s.cols.map((c) => [c.id, newIds ? uuid() : c.id]));
    const cols = [...s.cols].sort((a, b) => cmp(a.name, b.name));
    const orgId = s.orgId;

    const { encrypted, ...restMeta } = s.meta;
    const out = { encrypted: false, ...restMeta };

    if (format === 'org') {
      out.collections = cols.map((c) => {
        const o = { ...c, id: idMap.get(c.id) };
        if (!('organizationId' in o) || !o.organizationId) o.organizationId = orgId;
        if (!('externalId' in o)) o.externalId = null;
        return o;
      });
    } else {
      out.folders = cols.map((c) => ({ id: idMap.get(c.id), name: c.name }));
    }

    out.items = s.items.map((src) => {
      const o = clone(src);
      const ids = src.collectionIds.map((id) => idMap.get(id)).filter(Boolean);
      if (format === 'org') {
        o.collectionIds = ids;
        delete o.folderId;
        if (!o.organizationId) o.organizationId = orgId;
      } else {
        o.folderId = ids[0] ?? null;
        o.organizationId = null;
        o.collectionIds = null;
      }
      return o;
    });
    return out;
  }

  /** Problems worth showing before export. */
  function exportWarnings(s, format) {
    const w = [];
    const none = s.items.filter((i) => i.collectionIds.length === 0).length;
    if (none && format === 'org') {
      w.push(`${none} item không thuộc collection nào — sau khi import sẽ nằm ở mục "Unassigned" (chỉ admin thấy).`);
    }
    const multi = s.items.filter((i) => i.collectionIds.length > 1).length;
    if (multi && format === 'personal') {
      w.push(`${multi} item thuộc nhiều collection — định dạng cá nhân chỉ giữ được 1 thư mục (lấy cái đầu tiên).`);
    }
    const noName = s.items.filter((i) => !String(i.name || '').trim()).length;
    if (noName) w.push(`${noName} item không có tên — Vaultwarden sẽ từ chối khi import.`);
    return w;
  }

  const api = {
    uuid, cmp, clone, normName, parentName, leafName, joinName, isSelfOrDescendant,
    colById, colByName, itemById, parse, ensureParents, buildTree, itemMatches,
    planMoveCollection, planRenameCollection, renameSubtree, addCollection,
    dissolveCollection, deleteCollectionTree, collectionStats,
    moveItems, newItem, duplicateItem, deleteItems, touch, exportData, exportWarnings,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VWCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
