import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';
const bundle = await rolldown({
  input: fileURLToPath(new URL('../prototype/src/AdvanceEditor.tsx', import.meta.url)),
  external: () => true,
});
const output = await bundle.generate({ format: 'cjs', exports: 'named' });
await bundle.close();
type Node = { type: string; props: any; key?: string };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value?.props ? [value, ...nodes(value.props.children)] : [];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  return value?.props ? text(value.props.children) : typeof value === 'string' ? value : '';
}
function harness() {
  const slots: any[] = [],
    requests: any[] = [],
    busy: boolean[] = [],
    actions: string[] = [];
  let cursor = 0;
  const useState = (initial: any) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[i],
      (value: any) => {
        slots[i] = value;
      },
    ];
  };
  const jsx = (type: string, props: any, key?: string) => ({ type, props, key });
  const modules: any = {
    react: { useState },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './model.ts': {
      cents: (value: string) => Math.round(Number(value) * 100),
      decimal: (value: number) => (value / 100).toFixed(2),
      money: (value: number) => (value / 100).toFixed(2),
    },
    './ledger.ts': {
      ledgerCommand: async (request: any) => {
        requests.push(request);
        return { expenses: [], batches: [], advances: [900] };
      },
    },
    './ExpenseScreenshot.tsx': { ExpenseAttachment: () => null },
  };
  const exports: any = {};
  runInNewContext(output.output[0].code, {
    exports,
    require: (id: string) => modules[id],
    structuredClone,
    crypto: { randomUUID: () => 'synthetic-request' },
  });
  const props = {
    state: {
      expenses: [],
      batches: [],
      advances: [1000],
      advanceDetails: { 0: { date: '2026-10-13', note: '合成' } },
    },
    id: 0,
    onState: () => actions.push('state'),
    onClose: () => actions.push('close'),
    onBusy: (value: boolean) => {
      busy.push(value);
      if (!value) actions.push('unlocked');
    },
  };
  const render = () => {
    cursor = 0;
    return exports.default(props);
  };
  const find = (label: string) =>
    nodes(render()).find((node) => node.type === 'button' && text(node) === label)!;
  return { render, find, requests, busy, actions };
}
test('opening advance editing uses a distinct non-submit button and does not save; submitting saves once then unlocks before close', async () => {
  const h = harness(),
    edit = h.find('编辑预支');
  assert.ok(edit);
  assert.equal(edit.props.type, 'button');
  edit.props.onClick();
  const save = h.find('保存修改');
  assert.equal(save.props.type, 'submit');
  assert.equal(save.props.form, 'advance-editor');
  assert.notEqual(edit.key, save.key);
  assert.equal(h.requests.length, 0);
  assert.equal(h.busy.length, 0);
  for (const node of nodes(h.render()).filter((node) => node.type === 'button' && node !== save)) {
    if (node.props.type !== 'submit') assert.equal(node.props.type, 'button');
  }
  const amount = nodes(h.render()).find(
    (node) => node.type === 'input' && node.props.inputMode === 'decimal',
  )!;
  amount.props.onChange({ target: { value: '9.00' } });
  let prevented = false;
  nodes(h.render())
    .find((node) => node.type === 'form')!
    .props.onSubmit({
      preventDefault() {
        prevented = true;
      },
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].advance.amount, 900);
  assert.deepEqual(h.actions.slice(0, 3), ['state', 'unlocked', 'close']);
});
test('advance deletion requires confirmation and never submits the edit form', async () => {
  const h = harness();
  h.find('删除记录').props.onClick();
  assert.equal(h.requests.length, 0);
  const keep = h.find('保留记录');
  assert.equal(keep.props.type, 'button');
  keep.props.onClick();
  assert.equal(h.requests.length, 0);
  h.find('删除记录').props.onClick();
  const confirm = h.find('确认删除预支');
  assert.equal(confirm.props.type, 'button');
  confirm.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].kind, 'delete-advance');
});
