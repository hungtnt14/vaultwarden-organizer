// Usage: node test/core.test.js [path/to/export.json]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../public/core.js');

const file = process.argv[2] || path.join(__dirname, 'sample.json');
const text = fs.readFileSync(file, 'utf8');
const orig = JSON.parse(text);
const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));

// 1. Round-trip without changes and without new ids == original
{
  const { state, report } = C.parse(text);
  assert.strictEqual(report.dangling, 0);
  const out = C.exportData(state, { newIds: false });
  const list = out.collections || out.folders;
  const origList = orig.collections || orig.folders;
  const known = new Set(origList.map((c) => c.id));
  assert.deepStrictEqual(byId(list.filter((c) => known.has(c.id))), byId(origList));
  assert.strictEqual(list.length - origList.length, report.addedParents);
  assert.deepStrictEqual(out.items, orig.items.map((i) => (orig.collections ? i : { ...i, collectionIds: null })));
  console.log(`ok  round-trip (${state.cols.length} cols, ${state.items.length} items, +${report.addedParents} parents)`);
}

// 2. New ids keep the structure (names <-> memberships)
{
  const { state } = C.parse(text);
  const out = C.exportData(state, { newIds: true });
  const names = (o, list) => {
    const m = byId(list);
    return o.items.map((i) => (i.collectionIds || [i.folderId]).filter(Boolean).map((id) => m[id].name).sort());
  };
  const list = (o) => o.collections || o.folders;
  assert.deepStrictEqual(names(out, list(out)), names(orig, list(orig)));
  assert.ok(list(out).every((c) => !byId(list(orig))[c.id]));
  console.log('ok  regenerate ids');
}

// 3. Structural edits on a synthetic vault
{
  const { state: s } = C.parse(JSON.stringify({ encrypted: false, collections: [], items: [] }));
  s.orgId = 'org';
  const a = C.addCollection(s, null, 'A');
  const b = C.addCollection(s, a.id, 'B');
  const c = C.addCollection(s, b.id, 'C');
  const x = C.addCollection(s, null, 'X');
  const xb = C.addCollection(s, x.id, 'B');
  const i1 = C.newItem(s, 1, b.id);
  const i2 = C.newItem(s, 1, xb.id);
  const i3 = C.newItem(s, 2, c.id);
  assert.strictEqual(C.addCollection(s, null, 'A').name, 'A (2)');

  // move A/B under X -> conflicts with X/B -> merge
  let plan = C.planMoveCollection(s, b.id, x.id);
  assert.strictEqual(plan.newName, 'X/B');
  assert.strictEqual(plan.conflict, xb);
  const kept = C.renameSubtree(s, b.id, plan.newName);
  assert.strictEqual(kept, xb.id);
  assert.deepStrictEqual(i1.collectionIds, [xb.id]);
  assert.strictEqual(C.colById(s, c.id).name, 'X/B/C');
  assert.ok(!C.colById(s, b.id));

  // can't move into own descendant
  assert.ok(C.planMoveCollection(s, x.id, c.id).error);

  // copy then move item
  C.moveItems(s, [{ itemId: i2.id, fromColId: xb.id }], a.id, true);
  assert.deepStrictEqual(i2.collectionIds, [xb.id, a.id]);
  C.moveItems(s, [{ itemId: i2.id, fromColId: a.id }], c.id, false);
  assert.deepStrictEqual(i2.collectionIds, [xb.id, c.id]);

  // dissolve X/B: C goes to X/C, items go to X
  C.dissolveCollection(s, xb.id);
  assert.strictEqual(C.colById(s, c.id).name, 'X/C');
  assert.deepStrictEqual(i1.collectionIds, [x.id]);
  assert.deepStrictEqual(i2.collectionIds, [c.id, x.id]);

  // delete X tree: i1,i2,i3 only lived there -> deleted
  const r = C.deleteCollectionTree(s, x.id);
  assert.deepStrictEqual(r, { deletedCols: 2, deletedItems: 3 });
  assert.deepStrictEqual(s.cols.map((k) => k.name).sort(), ['A', 'A (2)']);

  // rename validation + parents auto-created
  assert.ok(C.planRenameCollection(s, a.id, 'a/b').error);
  const deep = C.addCollection(s, a.id, 'D');
  C.renameSubtree(s, deep.id, 'P/Q/D');
  assert.ok(C.colByName(s, 'P') && C.colByName(s, 'P/Q'));
  console.log('ok  structural edits');

  // personal export from org
  const it = C.newItem(s, 1, a.id);
  it.collectionIds.push(deep.id);
  const p = C.exportData(s, { format: 'personal', newIds: false });
  const pi = p.items.find((k) => k.id === it.id);
  assert.strictEqual(pi.folderId, a.id);
  assert.strictEqual(pi.collectionIds, null);
  assert.ok(p.folders && !p.collections);
  assert.strictEqual(C.exportWarnings(s, 'personal').length, 1);
  console.log('ok  personal export');
}
