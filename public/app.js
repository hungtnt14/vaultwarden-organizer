(() => {
  'use strict';
  const C = window.VWCore;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------------------------------------------------------------- helpers

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (['value', 'checked', 'selected', 'disabled'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    login: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M17 6l2 2M14 9l2 2"/>',
    note: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
    card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    identity: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    ssh: '<path d="m5 8 4 4-4 4M12 16h7"/>',
    caret: '<path d="m9 6 6 6-6 6"/>',
    none: '<circle cx="12" cy="12" r="8"/><path d="m6.5 6.5 11 11"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  };
  const TYPE_INFO = {
    1: { label: 'Đăng nhập', icon: 'login' },
    2: { label: 'Ghi chú bảo mật', icon: 'note' },
    3: { label: 'Thẻ', icon: 'card' },
    4: { label: 'Danh tính', icon: 'identity' },
    5: { label: 'SSH key', icon: 'ssh' },
  };
  const TYPE_OBJ = { 3: 'card', 4: 'identity', 5: 'sshKey' };
  const FIELD_TYPES = [[0, 'Văn bản'], [1, 'Ẩn'], [2, 'Boolean'], [3, 'Liên kết']];

  function icon(name, cls = 'ico') {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', cls);
    s.innerHTML = ICONS[name];
    return s;
  }

  function highlight(text, q) {
    text = String(text ?? '');
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return text;
    return [text.slice(0, i), h('mark', null, text.slice(i, i + q.length)), text.slice(i + q.length)];
  }

  let toastTimer;
  function toast(msg, { error = false, undoable = false } = {}) {
    const t = $('#toast');
    t.replaceChildren(h('span', null, msg));
    if (undoable) t.append(h('button', { onclick: () => { undo(); } }, 'Hoàn tác'));
    t.className = 'toast show' + (error ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), error ? 5000 : 3200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Đã copy');
  }

  function genPassword(len = 20) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    const out = [];
    const buf = new Uint8Array(1);
    while (out.length < len) {
      crypto.getRandomValues(buf);
      if (buf[0] < 256 - (256 % chars.length)) out.push(chars[buf[0] % chars.length]);
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- state

  let S = null;
  let fileName = '';
  let dirty = false;
  const undoStack = [];
  const redoStack = [];
  const expanded = new Set();
  let selected = null; // {kind:'item', id, ctx} | {kind:'col', id}
  const picked = new Set(); // multi-select row keys "itemId|ctxColId"
  let query = '';
  let drag = null;
  let editSnapTaken = false;

  const rowKey = (itemId, ctx) => `${itemId}|${ctx || ''}`;
  const splitKey = (k) => {
    const [itemId, ctx] = k.split('|');
    return { itemId, fromColId: ctx || null };
  };
  const colLabel = (id) => C.colById(S, id)?.name ?? '?';
  const word = () => (S.mode === 'org' ? 'collection' : 'thư mục');

  function pushUndo() {
    undoStack.push(JSON.stringify(S));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }

  /** Structural change: snapshot, mutate, re-render everything. */
  function commit(fn) {
    pushUndo();
    const r = fn();
    dirty = true;
    renderAll();
    return r;
  }

  /** Field edit from the editor: one snapshot per focus session, re-render the tree only. */
  function editMutate(item, fn) {
    if (!editSnapTaken) {
      pushUndo();
      editSnapTaken = true;
    }
    fn();
    if (item) C.touch(item);
    dirty = true;
    renderTree();
    updateToolbar();
  }

  function restore(from, to, label) {
    if (!from.length) return;
    to.push(JSON.stringify(S));
    S = JSON.parse(from.pop());
    dirty = true;
    validateSelection();
    renderAll();
    toast(label);
  }
  const undo = () => restore(undoStack, redoStack, 'Đã hoàn tác');
  const redo = () => restore(redoStack, undoStack, 'Đã làm lại');

  function validateSelection() {
    if (selected?.kind === 'item' && !C.itemById(S, selected.id)) selected = null;
    if (selected?.kind === 'col' && !C.colById(S, selected.id)) selected = null;
    if (selected?.kind === 'item') {
      const ids = C.itemById(S, selected.id).collectionIds;
      if (selected.ctx ? !ids.includes(selected.ctx) : ids.length) selected.ctx = ids[0] || '';
    }
    for (const k of [...picked]) {
      const { itemId, fromColId } = splitKey(k);
      const it = C.itemById(S, itemId);
      if (!it || (fromColId && !it.collectionIds.includes(fromColId))) picked.delete(k);
    }
  }

  function expandTo(colId) {
    let col = C.colById(S, colId);
    while (col) {
      expanded.add(col.id);
      const p = C.parentName(col.name);
      col = p !== null ? C.colByName(S, p) : null;
    }
  }

  /** Expand or collapse a collection together with everything nested in it. */
  function setSubtree(colId, open) {
    const col = C.colById(S, colId);
    for (const c of S.cols) {
      if (!C.isSelfOrDescendant(col.name, c.name)) continue;
      if (open) expanded.add(c.id);
      else expanded.delete(c.id);
    }
    renderTree();
  }

  function setAll(open) {
    expanded.clear();
    if (open) {
      S.cols.forEach((c) => expanded.add(c.id));
      expanded.add('__none');
    }
    renderTree();
  }

  // ---------------------------------------------------------------- loading

  function loadText(text, name) {
    if (dirty && !confirm('Dữ liệu hiện tại chưa được xuất. Mở file mới và bỏ thay đổi?')) return;
    let res;
    try {
      res = C.parse(text);
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    S = res.state;
    fileName = name;
    dirty = false;
    undoStack.length = redoStack.length = 0;
    expanded.clear();
    picked.clear();
    selected = null;
    query = '';
    $('#search').value = '';
    for (const n of C.buildTree(S).roots) expanded.add(n.col.id);
    expanded.add('__none');
    renderAll();
    const notes = [];
    if (res.report.dangling) notes.push(`bỏ ${res.report.dangling} liên kết tới collection không tồn tại`);
    if (res.report.addedParents) notes.push(`tạo thêm ${res.report.addedParents} collection cha bị thiếu`);
    toast(`Đã mở ${S.items.length} item, ${S.cols.length} ${word()}` + (notes.length ? ` (${notes.join(', ')})` : ''));
  }

  function readFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => loadText(String(r.result), file.name);
    r.onerror = () => toast('Không đọc được file', { error: true });
    r.readAsText(file);
  }

  // ---------------------------------------------------------------- tree rendering

  function renderAll() {
    if (S) validateSelection();
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function updateToolbar() {
    const has = !!S;
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
    for (const id of ['btnExport', 'btnNewRootCol', 'btnExpandAll', 'btnCollapseAll', 'search']) $('#' + id).disabled = !has;
    $('#dragHint').style.display = has && S.mode === 'org' ? '' : 'none';
    const st = $('#status');
    if (!has) {
      st.textContent = 'Chưa mở file';
      return;
    }
    st.replaceChildren(
      `${fileName} · ${S.mode === 'org' ? 'Organization' : 'Cá nhân'} · ${S.cols.length} ${word()} · ${S.items.length} item`,
      picked.size > 1 ? ` · đã chọn ${picked.size}` : '',
      dirty ? h('span', { class: 'dirty' }, ' · ● chưa xuất') : '',
    );
  }

  function renderTree() {
    const wrap = $('#tree');
    if (!S) {
      wrap.replaceChildren();
      return;
    }
    const scroll = wrap.scrollTop;
    const q = query.trim().toLowerCase();
    const tree = C.buildTree(S);
    const frag = document.createDocumentFragment();

    frag.append(h('div', { class: 'row root-row', dataset: { root: '1' } }, `⤒ Thả ${word()} vào đây để đưa lên cấp cao nhất`));
    for (const n of tree.roots) {
      const el = renderNode(n, 0, q);
      if (el) frag.append(el);
    }
    const noneItems = tree.unassigned.filter((it) => C.itemMatches(it, q));
    if (!q || noneItems.length) {
      const open = q || expanded.has('__none');
      frag.append(
        h('div', { class: 'node' + (open ? '' : ' collapsed'), dataset: { node: '__none' } },
          h('div', { class: 'row none-row', dataset: { none: '1' } },
            h('button', { class: 'caret' + (noneItems.length ? '' : ' empty'), dataset: { toggle: '__none' } }, icon('caret')),
            icon('none'),
            h('span', { class: 'name' }, S.mode === 'org' ? '(Không thuộc collection nào)' : '(Không có thư mục)'),
            h('span', { class: 'count' }, tree.unassigned.length)),
          h('div', { class: 'children' }, noneItems.map((it) => itemRow(it, '', 1, q)))),
      );
    }
    if (q && !frag.querySelector('.item-row, .col-row')) frag.append(h('div', { class: 'row muted' }, 'Không tìm thấy kết quả'));
    wrap.replaceChildren(frag);
    wrap.scrollTop = scroll;
  }

  function renderNode(n, depth, q) {
    const col = n.col;
    const leaf = C.leafName(col.name);
    const colMatch = !!q && leaf.toLowerCase().includes(q);
    const childEls = n.children.map((c) => renderNode(c, depth + 1, colMatch ? '' : q)).filter(Boolean);
    const items = colMatch ? n.items : n.items.filter((it) => C.itemMatches(it, q));
    if (q && !colMatch && !childEls.length && !items.length) return null;

    const open = q ? true : expanded.has(col.id);
    const hasKids = n.children.length + n.items.length > 0;
    const row = h('div', {
      class: 'row col-row' + (selected?.kind === 'col' && selected.id === col.id ? ' sel' : ''),
      draggable: 'true',
      dataset: { col: col.id },
      title: col.name,
    },
      h('button', { class: 'caret' + (hasKids ? '' : ' empty'), dataset: { toggle: col.id }, tabindex: '-1', title: 'Alt + click: mở/thu cả nhánh' }, icon('caret')),
      icon('folder'),
      h('span', { class: 'name' }, highlight(leaf, q)),
      h('span', { class: 'row-actions' },
        h('button', { dataset: { act: 'newcol' }, title: `Tạo ${word()} con` }, '+ thư mục'),
        h('button', { dataset: { act: 'newitem' }, title: 'Tạo item đăng nhập trong đây' }, '+ item')),
      h('span', { class: 'count', title: 'Tổng số item bên trong' }, n.total),
    );
    row.style.setProperty('--depth', depth);
    return h('div', { class: 'node' + (open ? '' : ' collapsed'), dataset: { node: col.id } },
      row,
      h('div', { class: 'children' }, childEls, items.map((it) => itemRow(it, col.id, depth + 1, q))));
  }

  function itemRow(it, ctx, depth, q) {
    const key = rowKey(it.id, ctx);
    let cls = 'row item-row';
    if (selected?.kind === 'item' && selected.id === it.id) cls += selected.ctx === ctx ? ' sel' : ' sel-alias';
    if (picked.has(key)) cls += ' picked';
    const info = TYPE_INFO[it.type] || { icon: 'note' };
    const n = it.collectionIds.length;
    const row = h('div', { class: cls, draggable: 'true', dataset: { item: it.id, ctx } },
      h('span', { class: 'caret empty' }),
      icon(info.icon),
      h('span', { class: 'name' }, highlight(it.name || '(không tên)', q)),
      it.favorite ? h('span', { class: 'star', title: 'Yêu thích' }, '★') : null,
      it.login?.username ? h('span', { class: 'sub' }, highlight(it.login.username, q)) : null,
      n > 1 ? h('span', { class: 'multi', title: `Nằm trong ${n} collection:\n` + it.collectionIds.map(colLabel).join('\n') }, `×${n}`) : null,
    );
    row.style.setProperty('--depth', depth);
    return row;
  }

  // ---------------------------------------------------------------- tree interaction

  const tree = $('#tree');

  tree.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      const node = toggle.closest('.node');
      if (e.altKey && id !== '__none') {
        setSubtree(id, node.classList.contains('collapsed'));
        return;
      }
      node.classList.toggle('collapsed');
      if (node.classList.contains('collapsed')) expanded.delete(id);
      else expanded.add(id);
      return;
    }
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('.row');
    if (!row) return;
    if (act && row.dataset.col) {
      const parentId = row.dataset.col;
      if (act.dataset.act === 'newcol') newCollection(parentId);
      else newItemIn(1, parentId);
      return;
    }
    if (row.dataset.col) {
      picked.clear();
      selected = { kind: 'col', id: row.dataset.col };
      renderAll();
    } else if (row.dataset.item) {
      const key = rowKey(row.dataset.item, row.dataset.ctx);
      if (e.ctrlKey || e.metaKey) {
        if (!picked.size && selected?.kind === 'item') picked.add(rowKey(selected.id, selected.ctx));
        if (picked.has(key)) picked.delete(key);
        else picked.add(key);
        if (picked.size === 1) {
          const only = splitKey([...picked][0]);
          selected = { kind: 'item', id: only.itemId, ctx: only.fromColId || '' };
          picked.clear();
        } else if (!picked.size) {
          selected = null;
        }
      } else {
        picked.clear();
        selected = { kind: 'item', id: row.dataset.item, ctx: row.dataset.ctx };
      }
      renderAll();
    }
  });

  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.col-row');
    if (row && !e.target.closest('[data-act],[data-toggle]')) row.querySelector('[data-toggle]').click();
  });

  // ---- drag & drop

  let hoverTimer = null;
  let hoverNode = null;

  function dropTarget(e) {
    const row = e.target.closest?.('.row');
    if (!row) return null;
    if (row.dataset.root) return { kind: 'root', colId: null, el: row };
    if (row.dataset.none) return { kind: 'none', colId: null, el: row.parentElement };
    if (row.dataset.col) return { kind: 'col', colId: row.dataset.col, el: row.parentElement, row };
    if (row.dataset.item) {
      const node = row.closest('.node');
      return row.dataset.ctx ? { kind: 'col', colId: row.dataset.ctx, el: node } : { kind: 'none', colId: null, el: node };
    }
    return null;
  }

  function canDrop(t) {
    if (!drag || !t) return false;
    if (drag.kind === 'item') return t.kind === 'col' || t.kind === 'none';
    const col = C.colById(S, drag.id);
    const curParent = C.parentName(col.name);
    if (t.kind === 'root') return curParent !== null;
    if (t.kind !== 'col') return false;
    const target = C.colById(S, t.colId);
    return !C.isSelfOrDescendant(col.name, target.name) && curParent !== target.name;
  }

  const dropLine = h('div', { class: 'drop-line' }, h('span', { class: 'lbl' }));

  function clearDropMarks() {
    tree.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop'));
    dropLine.remove();
  }

  /**
   * Draw a line where the dragged thing will actually end up. Vaultwarden sorts by name,
   * so the slot is the sorted position inside the target, not the spot under the cursor.
   */
  function showDropLine(t, copy) {
    const headRow = t.kind === 'root' ? t.el : t.el.firstElementChild;
    const container = t.kind === 'root' ? tree : t.el.classList.contains('collapsed') ? null : t.el.lastElementChild;
    const depth = t.kind === 'root' ? 0 : Number(headRow.style.getPropertyValue('--depth') || 0) + 1;
    const draggedNode = drag.kind === 'col' ? tree.querySelector(`.node[data-node="${drag.id}"]`) : null;

    let anchor = null; // element the line sits above
    let after = null; // element the line sits below (when no anchor)
    if (container) {
      const kids = [...container.children].filter((k) => k !== draggedNode && k !== dropLine);
      const nodes = kids.filter((k) => k.classList.contains('node') && k.dataset.node !== '__none');
      const items = kids.filter((k) => k.classList.contains('item-row') && !drag.ids?.has(k.dataset.item));
      const label = (el) => (el.classList.contains('node') ? el.firstElementChild : el).querySelector('.name').textContent;
      const pool = drag.kind === 'col' ? nodes : items;
      anchor = pool.find((el) => C.cmp(label(el), drag.sortName) > 0) || null;
      if (!anchor && drag.kind === 'col' && items.length) anchor = items[0];
      if (!anchor) after = (drag.kind === 'col' ? nodes : [...nodes, ...items]).at(-1) || headRow;
    } else {
      after = headRow;
    }

    const base = tree.getBoundingClientRect().top - tree.scrollTop;
    const r = (anchor || after).getBoundingClientRect();
    const y = (anchor ? r.top : r.bottom) - base;
    if (!dropLine.isConnected) tree.append(dropLine);
    dropLine.style.top = `${y - 1}px`;
    dropLine.style.left = `${12 + depth * 18}px`;
    const dest = t.kind === 'root' ? 'cấp cao nhất' : t.kind === 'none' ? 'không thuộc collection' : C.leafName(colLabel(t.colId));
    dropLine.firstElementChild.textContent = (copy ? '+ thêm vào ' : '→ ') + dest;

    tree.querySelectorAll('.row.drop').forEach((el) => el !== headRow && el.classList.remove('drop'));
    headRow.classList.add('drop');
  }

  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.row');
    if (!row || !S) return;
    if (row.dataset.item) {
      const key = rowKey(row.dataset.item, row.dataset.ctx);
      const keys = picked.has(key) && picked.size > 1 ? [...picked] : [key];
      const moves = keys.map(splitKey);
      const names = moves.map((m) => C.itemById(S, m.itemId)?.name || '').sort(C.cmp);
      drag = { kind: 'item', moves, ids: new Set(moves.map((m) => m.itemId)), sortName: names[0] };
      if (keys.length > 1) {
        const ghost = h('div', { class: 'drag-ghost' }, `${keys.length} item`);
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 10, 10);
        setTimeout(() => ghost.remove(), 0);
      }
    } else if (row.dataset.col) {
      drag = { kind: 'col', id: row.dataset.col, sortName: C.leafName(C.colById(S, row.dataset.col).name) };
    } else {
      e.preventDefault();
      return;
    }
    closeMenu();
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/x-vw-organizer', '1');
    requestAnimationFrame(() => row.classList.add('dragging'));
  });

  tree.addEventListener('dragover', (e) => {
    if (!drag) return;
    const t = dropTarget(e);
    if (!canDrop(t)) {
      e.dataTransfer.dropEffect = 'none';
      clearDropMarks();
      return;
    }
    e.preventDefault();
    const copy = drag.kind === 'item' && S.mode === 'org' && (e.ctrlKey || e.altKey);
    e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    showDropLine(t, copy);
    // hovering a collapsed folder opens it after a moment
    const node = t.row && t.el.classList.contains('collapsed') ? t.el : null;
    if (node !== hoverNode) {
      clearTimeout(hoverTimer);
      hoverNode = node;
      if (node) {
        hoverTimer = setTimeout(() => {
          node.classList.remove('collapsed');
          expanded.add(node.dataset.node);
        }, 650);
      }
    }
  });

  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget)) clearDropMarks();
  });

  tree.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const t = dropTarget(e);
    const d = drag;
    const ok = canDrop(t);
    endDrag();
    if (!ok) return;
    if (d.kind === 'item') dropItems(d.moves, t.colId, S.mode === 'org' && (e.ctrlKey || e.altKey));
    else dropCollection(d.id, t.colId);
  });

  function endDrag() {
    drag = null;
    clearTimeout(hoverTimer);
    hoverNode = null;
    clearDropMarks();
    tree.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  }
  window.addEventListener('dragend', endDrag, true);

  function dropItems(moves, toColId, copy) {
    if (!copy && moves.every((m) => (m.fromColId || null) === toColId)) return;
    const n = commitMove(moves, toColId, copy);
    if (!n) return;
    const dest = toColId ? colLabel(toColId) : '(không thuộc collection)';
    toast(`${copy ? 'Đã thêm' : 'Đã chuyển'} ${n} item → ${dest}`, { undoable: true });
  }

  function commitMove(moves, toColId, copy) {
    pushUndo();
    const n = C.moveItems(S, moves, toColId, copy);
    if (!n) {
      undoStack.pop();
      return 0;
    }
    dirty = true;
    if (selected?.kind === 'item' && moves.some((m) => m.itemId === selected.id)) {
      selected.ctx = toColId || C.itemById(S, selected.id).collectionIds[0] || '';
    }
    picked.clear();
    if (toColId) expandTo(toColId);
    else expanded.add('__none');
    renderAll();
    scrollToSelected();
    return n;
  }

  function dropCollection(colId, newParentId) {
    const plan = C.planMoveCollection(S, colId, newParentId);
    if (plan.error) return toast(plan.error, { error: true });
    if (plan.noop) return;
    if (plan.conflict && !confirm(`Đã có "${plan.newName}". Gộp nội dung vào ${word()} đó?`)) return;
    const keptId = commit(() => C.renameSubtree(S, colId, plan.newName));
    selected = { kind: 'col', id: keptId };
    expandTo(keptId);
    renderAll();
    scrollToSelected();
    toast(`Đã chuyển → ${plan.newName}`, { undoable: true });
  }

  function scrollToSelected() {
    requestAnimationFrame(() => tree.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  // ---------------------------------------------------------------- actions

  function newCollection(parentId) {
    const col = commit(() => C.addCollection(S, parentId, `${S.mode === 'org' ? 'Collection' : 'Thư mục'} mới`));
    if (parentId) expandTo(parentId);
    selected = { kind: 'col', id: col.id };
    renderAll();
    scrollToSelected();
    focusColName();
  }

  function newItemIn(type, colId) {
    const it = commit(() => C.newItem(S, type, colId));
    if (colId) expandTo(colId);
    selected = { kind: 'item', id: it.id, ctx: colId || '' };
    renderAll();
    scrollToSelected();
    const input = $('#itemName');
    input?.focus();
    input?.select();
  }

  function renameCollection(colId, leaf, input) {
    const plan = C.planRenameCollection(S, colId, leaf);
    if (plan.error) {
      toast(plan.error, { error: true });
      input.value = C.leafName(C.colById(S, colId).name);
      return;
    }
    if (plan.noop) return;
    if (plan.conflict && !confirm(`Đã có "${plan.newName}". Gộp hai ${word()} lại?`)) {
      input.value = C.leafName(C.colById(S, colId).name);
      return;
    }
    const keptId = commit(() => C.renameSubtree(S, colId, plan.newName));
    selected = { kind: 'col', id: keptId };
    renderAll();
  }

  function deleteItemsConfirm(ids) {
    const names = ids.map((id) => C.itemById(S, id)?.name).filter(Boolean);
    const msg = ids.length === 1 ? `Xóa item "${names[0]}"?` : `Xóa ${ids.length} item đã chọn?`;
    if (confirm(msg)) deleteItemsNow(ids);
  }

  function deleteItemsNow(ids) {
    commit(() => C.deleteItems(S, ids));
    selected = null;
    picked.clear();
    renderAll();
    toast(`Đã xóa ${ids.length} item`, { undoable: true });
  }

  function duplicateItemNow(itemId) {
    const ctx = selected?.kind === 'item' ? selected.ctx : '';
    const copy = commit(() => C.duplicateItem(S, itemId));
    selected = { kind: 'item', id: copy.id, ctx };
    renderAll();
    scrollToSelected();
  }

  function dissolveCollectionNow(colId) {
    const pid = commit(() => C.dissolveCollection(S, colId));
    selected = pid ? { kind: 'col', id: pid } : null;
    renderAll();
    toast('Đã giải thể', { undoable: true });
  }

  function deleteCollectionNow(colId) {
    const r = commit(() => C.deleteCollectionTree(S, colId));
    selected = null;
    renderAll();
    toast(`Đã xóa ${r.deletedCols} ${word()}, ${r.deletedItems} item`, { undoable: true });
  }

  function removeFromCollectionNow(itemId, colId) {
    commitMove([{ itemId, fromColId: colId }], null, false);
    toast(`Đã bỏ khỏi ${colLabel(colId)}`, { undoable: true });
  }

  // ---------------------------------------------------------------- context menu

  const menu = h('div', { class: 'ctx-menu', role: 'menu', hidden: true });
  document.body.append(menu);

  function openMenu(x, y, entries) {
    menu.replaceChildren(...entries.filter(Boolean).map((e) => {
      if (e === '-') return h('div', { class: 'sep' });
      if (e.head) return h('div', { class: 'head', title: e.head }, e.head);
      return h('button', {
        class: 'mi' + (e.danger ? ' danger' : ''),
        role: 'menuitem',
        disabled: !!e.disabled,
        onclick: () => {
          closeMenu();
          e.run();
        },
      }, h('span', null, e.label), e.hint ? h('kbd', null, e.hint) : null);
    }));
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    menu.querySelector('.mi:not(:disabled)')?.focus();
  }

  function closeMenu() {
    menu.hidden = true;
  }

  function itemMenu(it, ctx) {
    const leaf = ctx ? C.leafName(colLabel(ctx)) : '';
    return [
      { head: it.name || '(không tên)' },
      { label: 'Nhân bản', run: () => duplicateItemNow(it.id) },
      it.login ? { label: 'Copy username', disabled: !it.login.username, run: () => copyText(it.login.username) } : null,
      it.login ? { label: 'Copy mật khẩu', disabled: !it.login.password, run: () => copyText(it.login.password) } : null,
      '-',
      S.mode === 'org' && ctx && it.collectionIds.length > 1
        ? { label: `Bỏ khỏi "${leaf}" (giữ ở ${it.collectionIds.length - 1} nơi khác)`, run: () => removeFromCollectionNow(it.id, ctx) }
        : null,
      { label: 'Xóa item', hint: 'Del', danger: true, run: () => deleteItemsNow([it.id]) },
    ];
  }

  function multiMenu() {
    const ids = [...new Set([...picked].map((k) => splitKey(k).itemId))];
    return [
      { head: `${ids.length} item đã chọn` },
      { label: 'Bỏ chọn', hint: 'Esc', run: () => { picked.clear(); renderAll(); } },
      '-',
      { label: `Xóa ${ids.length} item`, hint: 'Del', danger: true, run: () => deleteItemsNow(ids) },
    ];
  }

  function colMenu(col) {
    const st = C.collectionStats(S, col.id);
    const parts = [st.descendants && `${st.descendants} ${word()} con`, st.onlyHere && `${st.onlyHere} item chỉ nằm ở đây`].filter(Boolean);
    return [
      { head: col.name },
      { label: `+ ${word()[0].toUpperCase() + word().slice(1)} con`, run: () => newCollection(col.id) },
      { label: '+ Đăng nhập', run: () => newItemIn(1, col.id) },
      { label: '+ Ghi chú bảo mật', run: () => newItemIn(2, col.id) },
      { label: 'Đổi tên', hint: 'F2', run: () => focusColName() },
      '-',
      { label: 'Mở hết bên trong', hint: 'Alt+click', run: () => setSubtree(col.id, true) },
      { label: 'Thu gọn bên trong', run: () => setSubtree(col.id, false) },
      '-',
      { label: 'Giải thể (đưa nội dung lên cấp cha)', run: () => dissolveCollectionNow(col.id) },
      { label: parts.length ? `Xóa (gồm ${parts.join(', ')})` : 'Xóa', hint: 'Del', danger: true, run: () => deleteCollectionNow(col.id) },
    ];
  }

  function focusColName() {
    const input = $('#colName');
    input?.focus();
    input?.select();
  }

  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row || !S) return;
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    if (row.dataset.item) {
      if (picked.size > 1 && picked.has(rowKey(row.dataset.item, row.dataset.ctx))) return openMenu(x, y, multiMenu());
      picked.clear();
      selected = { kind: 'item', id: row.dataset.item, ctx: row.dataset.ctx };
      renderAll();
      openMenu(x, y, itemMenu(C.itemById(S, row.dataset.item), row.dataset.ctx));
    } else if (row.dataset.col) {
      picked.clear();
      selected = { kind: 'col', id: row.dataset.col };
      renderAll();
      openMenu(x, y, colMenu(C.colById(S, row.dataset.col)));
    } else if (row.dataset.root) {
      openMenu(x, y, [
        { label: `+ ${word()} mới ở cấp cao nhất`, run: () => newCollection(null) },
        '-',
        { label: 'Mở hết', run: () => setAll(true) },
        { label: 'Thu hết', run: () => setAll(false) },
      ]);
    } else if (row.dataset.none) {
      openMenu(x, y, [{ label: '+ Đăng nhập', run: () => newItemIn(1, null) }, { label: '+ Ghi chú bảo mật', run: () => newItemIn(2, null) }]);
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  // not 'scroll': re-rendering the tree restores scrollTop, which would close the menu right after opening
  tree.addEventListener('wheel', closeMenu, { passive: true });

  // ---------------------------------------------------------------- editor

  function renderEditor() {
    const ed = $('#editor');
    editSnapTaken = false;
    if (!S) return ed.replaceChildren(welcome());
    if (picked.size > 1) return ed.replaceChildren(multiEditor());
    if (selected?.kind === 'item') return ed.replaceChildren(itemEditor(C.itemById(S, selected.id)));
    if (selected?.kind === 'col') return ed.replaceChildren(colEditor(C.colById(S, selected.id)));
    ed.replaceChildren(overview());
  }

  function welcome() {
    return h('div', { class: 'welcome' },
      h('div', { class: 'dropzone', onclick: () => $('#fileInput').click() },
        icon('upload'),
        h('h2', null, 'Mở file export của Vaultwarden'),
        h('p', { class: 'muted' }, 'Bấm để chọn hoặc kéo thả file .json vào trang này')),
      h('ul', null,
        h('li', null, 'Trong Vaultwarden: Tools → Export vault → định dạng ', h('b', null, '.json'), ' (không mã hóa). Hỗ trợ cả export Organization lẫn cá nhân.'),
        h('li', null, 'Toàn bộ dữ liệu chỉ xử lý trong trình duyệt này — không gửi lên server, không lưu vào ổ đĩa.'),
        h('li', null, 'Đóng tab là mất dữ liệu chưa xuất — nhớ bấm “Xuất JSON”.')));
  }

  function overview() {
    const multi = S.items.filter((i) => i.collectionIds.length > 1).length;
    return h('div', { class: 'help' },
      h('h1', null, 'Tổng quan'),
      h('div', { class: 'crumbs' }, fileName),
      h('div', { class: 'card' }, h('div', { class: 'stats' },
        stat(S.cols.length, word()),
        stat(S.items.length, 'item'),
        stat(S.items.filter((i) => i.type === 1).length, 'đăng nhập'),
        stat(S.items.filter((i) => i.type === 2).length, 'ghi chú'),
        S.mode === 'org' ? stat(multi, 'item ở nhiều collection') : null)),
      h('div', { class: 'card' },
        h('h3', null, 'Cách dùng'),
        h('ul', null,
          h('li', null, h('b', null, 'Kéo item'), ` thả vào một ${word()} (hoặc lên item khác trong ${word()} đó) để chuyển.`),
          S.mode === 'org' ? h('li', null, 'Giữ ', h('kbd', null, 'Ctrl'), ' khi thả để ', h('b', null, 'thêm'), ' item vào collection đó mà vẫn giữ ở chỗ cũ. Badge ×2, ×3 cho biết item nằm ở nhiều nơi.') : null,
          h('li', null, h('b', null, `Kéo ${word()}`), ` thả vào ${word()} khác để lồng vào; thả lên dòng “⤒” trên cùng để đưa lên cấp cao nhất. Trùng tên sẽ được hỏi gộp.`),
          h('li', null, h('kbd', null, 'Ctrl'), ' + click để chọn nhiều item rồi kéo cùng lúc.'),
          h('li', null, h('kbd', null, 'Ctrl+Z'), ' / ', h('kbd', null, 'Ctrl+Y'), ' hoàn tác / làm lại, ', h('kbd', null, '/'), ' tìm kiếm, ', h('kbd', null, 'Ctrl+S'), ' xuất file.'),
          h('li', null, 'Vaultwarden luôn sắp xếp theo tên A→Z, nên cây ở đây cũng vậy. Muốn ép thứ tự thì đặt tiền tố, ví dụ “01 - Production”.'))));
  }

  const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, label));

  function colOptions({ exclude, includeRoot, rootLabel, placeholder } = {}) {
    const opts = [];
    if (placeholder) opts.push(h('option', { value: '', disabled: true, selected: true }, placeholder));
    if (includeRoot) opts.push(h('option', { value: '__root' }, rootLabel || '(Cấp cao nhất)'));
    for (const c of [...S.cols].sort((a, b) => C.cmp(a.name, b.name))) {
      if (exclude && C.isSelfOrDescendant(exclude.name, c.name)) continue;
      const depth = c.name.split('/').length - 1;
      opts.push(h('option', { value: c.id }, '  '.repeat(depth) + C.leafName(c.name)));
    }
    return opts;
  }

  function colEditor(col) {
    const st = C.collectionStats(S, col.id);
    const parent = C.parentName(col.name);
    const parentCol = parent !== null ? C.colByName(S, parent) : null;

    const nameInput = h('input', { id: 'colName', value: C.leafName(col.name) });
    nameInput.addEventListener('change', () => renameCollection(col.id, nameInput.value, nameInput));
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur();
      if (e.key === 'Escape') {
        nameInput.value = C.leafName(col.name);
        nameInput.blur();
      }
    });

    const parentSel = h('select', null, colOptions({ exclude: col, includeRoot: true }));
    parentSel.value = parentCol ? parentCol.id : '__root';
    parentSel.addEventListener('change', () => {
      dropCollection(col.id, parentSel.value === '__root' ? null : parentSel.value);
      if (C.colById(S, col.id)) parentSel.value = parentCol ? parentCol.id : '__root';
    });

    const extra = Object.entries(col).filter(([k, v]) => !['id', 'name', 'organizationId'].includes(k) && v != null);

    return h('div', null,
      h('h1', null, icon('folder'), C.leafName(col.name)),
      h('div', { class: 'crumbs' }, col.name),
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Tên (Enter để lưu)'), nameInput),
        h('label', { class: 'field' }, h('span', null, 'Nằm trong'), parentSel)),
      h('div', { class: 'card' }, h('div', { class: 'stats' },
        stat(st.direct, 'item trực tiếp'),
        stat(st.childCols, `${word()} con`),
        stat(st.inTree, 'item tính cả cấp con'))),
      h('div', { class: 'card' },
        h('h3', null, 'Thao tác'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => newCollection(col.id) }, `+ ${word()} con`),
          h('button', { class: 'btn', onclick: () => newItemIn(1, col.id) }, '+ Đăng nhập'),
          h('button', { class: 'btn', onclick: () => newItemIn(2, col.id) }, '+ Ghi chú bảo mật'),
          h('button', {
            class: 'btn',
            title: 'Xóa riêng collection này, đưa item và collection con lên cấp cha',
            onclick: () => {
              const where = parent ?? (S.mode === 'org' ? '(không thuộc collection)' : '(không có thư mục)');
              if (confirm(`Bỏ "${col.name}" và đưa toàn bộ nội dung lên "${where}"?`)) dissolveCollectionNow(col.id);
            },
          }, 'Giải thể (giữ nội dung)'),
          h('button', {
            class: 'btn danger',
            onclick: () => {
              const msg = `Xóa "${col.name}"` + (st.descendants ? ` cùng ${st.descendants} ${word()} con` : '') +
                (st.onlyHere ? ` và ${st.onlyHere} item chỉ nằm trong đây` : '') + '?';
              if (confirm(msg)) deleteCollectionNow(col.id);
            },
          }, 'Xóa'))),
      extra.length
        ? h('div', { class: 'card meta' }, h('div', null, `ID: ${col.id}`), extra.map(([k, v]) => h('div', null, `${k}: ${JSON.stringify(v)}`)))
        : h('div', { class: 'card meta' }, `ID: ${col.id}`));
  }

  function multiEditor() {
    const moves = [...picked].map(splitKey);
    const ids = [...new Set(moves.map((m) => m.itemId))];
    const moveSel = h('select', { class: 'add-select' }, colOptions({ placeholder: `Chuyển tới ${word()}…` }));
    moveSel.addEventListener('change', () => {
      const n = commitMove(moves, moveSel.value, false);
      toast(`Đã chuyển ${n} item → ${colLabel(moveSel.value)}`, { undoable: true });
    });
    const addSel = h('select', { class: 'add-select' }, colOptions({ placeholder: 'Thêm vào collection (giữ chỗ cũ)…' }));
    addSel.addEventListener('change', () => {
      const n = commitMove(moves, addSel.value, true);
      toast(`Đã thêm ${n} item → ${colLabel(addSel.value)}`, { undoable: true });
    });
    return h('div', null,
      h('h1', null, `${ids.length} item đã chọn`),
      h('div', { class: 'crumbs' }, 'Ctrl + click để thêm/bớt · Esc để bỏ chọn'),
      h('div', { class: 'card' },
        h('ul', null, ids.map((id) => h('li', null, C.itemById(S, id).name)))),
      h('div', { class: 'card' },
        h('h3', null, 'Thao tác'),
        h('label', { class: 'field' }, moveSel),
        S.mode === 'org' ? h('label', { class: 'field' }, addSel) : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => { picked.clear(); renderAll(); } }, 'Bỏ chọn'),
          h('button', { class: 'btn danger', onclick: () => deleteItemsConfirm(ids) }, `Xóa ${ids.length} item`))));
  }

  /** Text input bound to obj[key]. */
  function bound(item, obj, key, attrs = {}) {
    const tag = attrs.multiline ? 'textarea' : 'input';
    const { multiline, nullable, ...rest } = attrs;
    const el = h(tag, { ...rest, value: obj[key] ?? '' });
    el.addEventListener('input', () => editMutate(item, () => {
      obj[key] = el.value === '' && nullable ? null : el.value;
    }));
    return el;
  }

  function itemEditor(it) {
    const info = TYPE_INFO[it.type] || { label: `Loại ${it.type}`, icon: 'note' };
    const nameInput = bound(it, it, 'name', { id: 'itemName' });
    const fav = h('input', { type: 'checkbox', checked: !!it.favorite });
    fav.addEventListener('change', () => { editMutate(it, () => { it.favorite = fav.checked; }); editSnapTaken = false; });
    const rep = h('input', { type: 'checkbox', checked: it.reprompt === 1 });
    rep.addEventListener('change', () => { editMutate(it, () => { it.reprompt = rep.checked ? 1 : 0; }); editSnapTaken = false; });

    const where = (selected.ctx ? colLabel(selected.ctx) : '(không thuộc collection)');

    return h('div', null,
      h('h1', null, icon(info.icon), it.name || '(không tên)'),
      h('div', { class: 'crumbs' }, `${info.label} · ${where}`),
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Tên'), nameInput),
        h('div', { class: 'inline-checks' },
          h('label', { class: 'check' }, fav, 'Yêu thích'),
          h('label', { class: 'check' }, rep, 'Hỏi lại master password khi xem'))),
      it.type === 1 ? loginCard(it) : null,
      TYPE_OBJ[it.type] && it[TYPE_OBJ[it.type]] ? objectCard(it, it[TYPE_OBJ[it.type]], info.label) : null,
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Ghi chú'), bound(it, it, 'notes', { multiline: true, nullable: true, rows: 5 }))),
      fieldsCard(it),
      membershipCard(it),
      rawCard(it),
      h('div', { class: 'card' },
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => duplicateItemNow(it.id) }, 'Nhân bản'),
          h('button', { class: 'btn danger', onclick: () => deleteItemsConfirm([it.id]) }, 'Xóa item')),
        h('div', { class: 'meta' },
          h('div', null, `ID: ${it.id}`),
          h('div', null, `Tạo: ${fmtDate(it.creationDate)} · Sửa: ${fmtDate(it.revisionDate)}`),
          it.passwordHistory?.length ? h('div', null, `Lịch sử mật khẩu: ${it.passwordHistory.length} mục (giữ nguyên)`) : null,
          it.login?.fido2Credentials?.length ? h('div', null, `Passkey: ${it.login.fido2Credentials.length} (giữ nguyên)`) : null)));
  }

  const fmtDate = (s) => (s ? new Date(s).toLocaleString('vi-VN') : '—');

  function loginCard(it) {
    const L = it.login;
    const user = bound(it, L, 'username', { nullable: true, autocomplete: 'off' });
    const pass = bound(it, L, 'password', { type: 'password', class: 'mono', nullable: true, autocomplete: 'new-password' });
    const totp = bound(it, L, 'totp', { class: 'mono', nullable: true, autocomplete: 'off', placeholder: 'otpauth://… hoặc secret' });
    const eye = h('button', { class: 'btn icon', type: 'button', title: 'Hiện/ẩn' }, '👁');
    eye.addEventListener('click', () => { pass.type = pass.type === 'password' ? 'text' : 'password'; });
    const gen = h('button', { class: 'btn icon', type: 'button', title: 'Sinh mật khẩu ngẫu nhiên' }, '⟳');
    gen.addEventListener('click', () => {
      if (L.password && !confirm('Thay mật khẩu hiện tại bằng mật khẩu ngẫu nhiên?')) return;
      editSnapTaken = false;
      editMutate(it, () => { L.password = genPassword(); });
      editSnapTaken = false;
      pass.value = L.password;
      pass.type = 'text';
    });
    const copyBtn = (input) => h('button', { class: 'btn icon', type: 'button', title: 'Copy', onclick: () => input.value && copyText(input.value) }, '⧉');

    L.uris = L.uris || [];
    const uriList = h('div');
    const drawUris = () => {
      uriList.replaceChildren(...L.uris.map((u, i) => {
        const inp = bound(it, u, 'uri', { placeholder: 'https://…' });
        return h('div', { class: 'grid-row uri' }, inp,
          h('button', { class: 'btn icon danger', type: 'button', title: 'Xóa URL', onclick: () => {
            editSnapTaken = false;
            editMutate(it, () => L.uris.splice(i, 1));
            editSnapTaken = false;
            drawUris();
          } }, '✕'));
      }));
    };
    drawUris();

    return h('div', { class: 'card' },
      h('h3', null, 'Đăng nhập'),
      h('label', { class: 'field' }, h('span', null, 'Username'), h('div', { class: 'input-group' }, user, copyBtn(user))),
      h('label', { class: 'field' }, h('span', null, 'Mật khẩu'), h('div', { class: 'input-group' }, pass, eye, copyBtn(pass), gen)),
      h('label', { class: 'field' }, h('span', null, 'TOTP'), totp),
      h('div', { class: 'field' }, h('span', null, 'URL'), uriList,
        h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => {
          editSnapTaken = false;
          editMutate(it, () => L.uris.push({ match: null, uri: '' }));
          editSnapTaken = false;
          drawUris();
          uriList.lastElementChild?.querySelector('input')?.focus();
        } }, '+ URL'))));
  }

  function objectCard(it, obj, label) {
    return h('div', { class: 'card' },
      h('h3', null, label),
      Object.keys(obj).filter((k) => obj[k] == null || typeof obj[k] === 'string').map((k) => {
        const long = String(obj[k] ?? '').length > 60 || String(obj[k] ?? '').includes('\n');
        return h('label', { class: 'field' }, h('span', null, k), bound(it, obj, k, { nullable: true, multiline: long, class: 'mono' }));
      }));
  }

  function fieldsCard(it) {
    it.fields = it.fields || [];
    const list = h('div');
    const draw = () => {
      list.replaceChildren(...it.fields.map((f, i) => {
        const typeSel = h('select', null, FIELD_TYPES.map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)));
        typeSel.addEventListener('change', () => {
          editSnapTaken = false;
          editMutate(it, () => {
            f.type = Number(typeSel.value);
            if (f.type === 2) f.value = f.value === 'true' ? 'true' : 'false';
          });
          editSnapTaken = false;
          draw();
        });
        let valueEl;
        if (f.type === 2) {
          valueEl = h('input', { type: 'checkbox', checked: f.value === 'true' });
          valueEl.addEventListener('change', () => { editMutate(it, () => { f.value = valueEl.checked ? 'true' : 'false'; }); editSnapTaken = false; });
          valueEl = h('label', { class: 'check' }, valueEl, 'true');
        } else if (f.type === 3) {
          valueEl = h('input', { value: `linkedId: ${f.linkedId ?? '?'}`, disabled: true });
        } else {
          valueEl = bound(it, f, 'value', { type: f.type === 1 ? 'password' : 'text', nullable: true, class: 'mono', autocomplete: 'off' });
          if (f.type === 1) {
            valueEl.addEventListener('focus', () => { valueEl.type = 'text'; });
            valueEl.addEventListener('blur', () => { valueEl.type = 'password'; });
          }
        }
        return h('div', { class: 'grid-row cf' },
          typeSel,
          bound(it, f, 'name', { placeholder: 'Tên trường' }),
          valueEl,
          h('button', { class: 'btn icon danger', type: 'button', title: 'Xóa trường', onclick: () => {
            editSnapTaken = false;
            editMutate(it, () => it.fields.splice(i, 1));
            editSnapTaken = false;
            draw();
          } }, '✕'));
      }));
    };
    draw();
    return h('div', { class: 'card' },
      h('h3', null, `Trường tùy chỉnh (${it.fields.length})`),
      list,
      h('button', { class: 'btn sm', type: 'button', onclick: () => {
        editSnapTaken = false;
        editMutate(it, () => it.fields.push({ name: '', value: '', type: 0, linkedId: null }));
        editSnapTaken = false;
        draw();
        list.lastElementChild?.querySelectorAll('input')[0]?.focus();
      } }, '+ Trường'));
  }

  function membershipCard(it) {
    if (S.mode === 'personal') {
      const sel = h('select', null, h('option', { value: '' }, '(Không có thư mục)'), colOptions());
      sel.value = it.collectionIds[0] || '';
      sel.addEventListener('change', () => {
        commitMove([{ itemId: it.id, fromColId: it.collectionIds[0] || null }], sel.value || null, false);
      });
      return h('div', { class: 'card' }, h('h3', null, 'Thư mục'), sel);
    }
    const add = h('select', { class: 'add-select' }, colOptions({ placeholder: '+ Thêm vào collection…' }));
    add.addEventListener('change', () => {
      commitMove([{ itemId: it.id, fromColId: null }], add.value, true);
    });
    return h('div', { class: 'card' },
      h('h3', null, `Collection (${it.collectionIds.length})`),
      h('div', { class: 'chips' },
        it.collectionIds.length
          ? it.collectionIds.map((cid) => h('span', { class: 'chip', title: colLabel(cid) },
            h('span', null, colLabel(cid)),
            h('button', { type: 'button', title: 'Bỏ khỏi collection này', onclick: () => {
              commitMove([{ itemId: it.id, fromColId: cid }], null, false);
            } }, '✕')))
          : h('span', { class: 'muted' }, 'Không thuộc collection nào')),
      add);
  }

  function rawCard(it) {
    const ta = h('textarea', { class: 'raw', spellcheck: 'false' });
    const err = h('div', { class: 'err' });
    const det = h('details', { class: 'card' },
      h('summary', null, 'JSON thô (nâng cao)'),
      ta, err,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          let obj;
          try {
            obj = JSON.parse(ta.value);
          } catch (e) {
            err.textContent = e.message;
            return;
          }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            err.textContent = 'Phải là một object JSON';
            return;
          }
          const valid = new Set(S.cols.map((c) => c.id));
          obj.id = it.id;
          obj.collectionIds = (Array.isArray(obj.collectionIds) ? obj.collectionIds : it.collectionIds).filter((id) => valid.has(id));
          commit(() => {
            const idx = S.items.findIndex((x) => x.id === it.id);
            S.items[idx] = obj;
          });
          validateSelection();
          renderAll();
          toast('Đã áp dụng JSON', { undoable: true });
        } }, 'Áp dụng')));
    det.addEventListener('toggle', () => {
      if (det.open) ta.value = JSON.stringify(C.itemById(S, it.id), null, 2);
    });
    return det;
  }

  $('#editor').addEventListener('focusout', () => { editSnapTaken = false; });

  // ---------------------------------------------------------------- export

  const dlg = $('#exportDlg');
  const form = dlg.querySelector('form');

  function openExport() {
    if (!S) return;
    form.format.value = S.mode;
    const base = fileName.replace(/\.json$/i, '').replace(/_sorted(_\d{8}-\d{4})?$/, '');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    form.filename.value = `${base}_sorted_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    drawWarnings();
    dlg.returnValue = '';
    dlg.showModal();
  }

  function drawWarnings() {
    $('#exportWarnings').replaceChildren(...C.exportWarnings(S, form.format.value).map((w) => h('li', null, w)));
  }
  form.addEventListener('change', drawWarnings);

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const data = C.exportData(S, { format: form.format.value, newIds: form.newIds.checked });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const name = form.filename.value.trim() || 'vaultwarden_export.json';
    const a = h('a', { href: url, download: name.endsWith('.json') ? name : name + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    dirty = false;
    updateToolbar();
    toast(`Đã xuất ${data.items.length} item → ${name}`);
  });

  // ---------------------------------------------------------------- wiring

  $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    readFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnExport').addEventListener('click', openExport);
  $('#btnNewRootCol').addEventListener('click', () => newCollection(null));
  $('#btnExpandAll').addEventListener('click', () => setAll(true));
  $('#btnCollapseAll').addEventListener('click', () => setAll(false));
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = e.target.value;
      renderTree();
    }, 120);
  });

  // file drop anywhere on the page
  const overlay = $('#dropOverlay');
  const isFileDrag = (e) => !drag && [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    overlay.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) overlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    overlay.classList.remove('show');
    if (!isFileDrag(e)) return;
    e.preventDefault();
    readFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('keydown', (e) => {
    if (!menu.hidden) {
      const items = [...menu.querySelectorAll('.mi:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') closeMenu();
      else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
      else if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.key !== 'Enter' && e.key !== ' ') e.preventDefault();
      return;
    }
    const inField = e.target.closest?.('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      openExport();
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      $('#fileInput').click();
    } else if (!inField && S && mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (!inField && S && mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (!inField && e.key === '/' && S) {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key === 'Escape' && !inField && S && (picked.size || selected)) {
      picked.clear();
      selected = null;
      renderAll();
    } else if (!inField && S && e.key === 'F2' && selected?.kind === 'col') {
      e.preventDefault();
      focusColName();
    } else if (!inField && S && e.key === 'Delete' && selected?.kind === 'col' && picked.size < 2) {
      const col = C.colById(S, selected.id);
      if (confirm(`Xóa "${col.name}" và toàn bộ nội dung?`)) deleteCollectionNow(col.id);
    } else if (!inField && S && e.key === 'Delete' && (picked.size > 1 || selected?.kind === 'item')) {
      deleteItemsConfirm(picked.size > 1 ? [...new Set([...picked].map((k) => splitKey(k).itemId))] : [selected.id]);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  renderAll();
})();
