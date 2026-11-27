import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';
import { balance } from '../src/renderer/model.ts';
const require = createRequire(import.meta.url);
const { openLedger } = require('../src/main/ledger.cjs');
// Compile the actual App only in memory; use its handlers with a fresh synthetic SQLite ledger.
// The reimbursement form lives in its own file, so it is compiled in with the App.
const compiledIn = /[\\/]ReimburseForm\.tsx$/;
const build = await rolldown({
  input: fileURLToPath(new URL('../src/renderer/main.tsx', import.meta.url)),
  external: (id: string) => !compiledIn.test(id),
});
const compiled = await build.generate({ format: 'cjs' });
await build.close();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Element = { type: any; props: any };
// Components compiled in (the form, without hooks of its own) are drawn in place.
const drawn = (value: any) => (typeof value?.type === 'function' ? value.type(value.props) : value);
function elements(value: any): Element[] {
  value = drawn(value);
  return Array.isArray(value)
    ? value.flatMap(elements)
    : value?.props
      ? [value, ...elements(value.props.children)]
      : [];
}
function text(value: any): string {
  value = drawn(value);
  return Array.isArray(value)
    ? value.map(text).join('')
    : value?.props
      ? text(value.props.children)
      : typeof value === 'string'
        ? value
        : '';
}
function cash(state: any) {
  return {
    expenses: state.expenses,
    advances: state.advances,
    advanceDetails: state.advanceDetails,
    flows: [
      ...state.advances.map((amount: number, index: number) => ({
        kind: 'advance',
        index,
        amount,
        ...state.advanceDetails?.[index],
      })),
      ...state.expenses.map((expense: any) => ({
        kind: 'expense',
        ...expense,
        amount: -expense.amount,
      })),
    ],
    balance: balance(state.expenses, state.advances),
  };
}
async function fixture(
  t: any,
  transport?: (request: any, send: (request: any) => Promise<any>) => Promise<any>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-batch-retry-')),
    ledger = openLedger(root);
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = (request: any) => ledger.command(request);
  await send({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 1000, date: '2026-10-16', note: '合成预支' },
  });
  for (const category of ['接待', '办公'])
    await send({
      kind: 'expense',
      requestId: randomUUID(),
      expense: {
        category,
        amount: 10000,
        date: '2026-10-16',
        merchant: '合成' + category,
        note: '',
      },
    });
  const slots: any[] = [],
    effects: Array<() => void> = [],
    requests: any[] = [];
  let cursor = 0,
    App: () => Element;
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value: any) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => void, deps: any[]) {
      const index = cursor++,
        old = slots[index];
      if (!old || deps.some((v, i) => v !== old[i])) {
        slots[index] = deps;
        effects.push(effect);
      }
    },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const modules: any = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom/client': {
      createRoot: () => ({
        render: (element: Element) => {
          App = element.type;
        },
      }),
    },
    './ledger.ts': {
      onLedgerReloaded: () => () => {},
      ledgerCommand: async (request: any) => {
        const copy = structuredClone(request);
        if (copy.kind !== 'batch') return send(copy);
        requests.push(copy);
        return transport ? transport(copy, send) : send(copy);
      },
    },
    './Pagination.tsx': { default: () => null, usePagination: (items: any[]) => ({ items }) },
  };
  runInNewContext(compiled.output[0].code, {
    exports: {},
    require: (id: string) =>
      modules[id] ??
      (id.endsWith('.css') || id.endsWith('.tsx') ? {} : require(path.resolve('src/renderer', id))),
    crypto: { randomUUID },
    structuredClone,
    window: {
      addEventListener() {},
      removeEventListener() {},
      setInterval() {
        return 0;
      },
      clearInterval() {},
    },
    document: {
      getElementById() {
        return {};
      },
      addEventListener() {},
      removeEventListener() {},
    },
    sessionStorage: {
      getItem() {
        return null;
      },
    },
  });
  function render() {
    cursor = 0;
    const tree = App!();
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  function find(predicate: (node: Element) => boolean) {
    const value = elements(render()).find(predicate);
    assert.ok(value, 'Expected interactive element');
    return value;
  }
  function button(label: string) {
    return find((node) => node.type === 'button' && text(node) === label);
  }
  function field(label: string) {
    return find((node) => node.type === 'input' && node.props['aria-label'] === label);
  }
  function changeTotal(value: string) {
    find(
      (node) =>
        node.type === 'input' && node.props.inputMode === 'decimal' && !node.props['aria-label'],
    ).props.onChange({ target: { value } });
  }
  const submit = () => find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  render();
  await settle();
  render();
  button('登记报销').props.onClick();
  field('报销选择费用 1 合成接待').props.onChange();
  changeTotal('50.00');
  return {
    requests,
    send,
    read: () => send({ kind: 'read' }),
    button,
    field,
    changeTotal,
    submit,
    render,
  };
}

test('a transient batch-save failure can retry unchanged fields with the same request ID', async (t) => {
  let fail = true;
  const h = await fixture(t, async (request, send) => {
    if (fail) {
      fail = false;
      throw Error('synthetic transient failure');
    }
    return send(request);
  });
  const before = await h.read();
  await h.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(
    h.button('确认登记').props.disabled,
    false,
    'a request failure must not disable the retry button',
  );
  await h.submit();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1], h.requests[0]);
  const after = await h.read();
  assert.equal(after.batches.length, 1);
  assert.deepEqual(cash(after), cash(before));
});

test('an unchanged retry after a committed response is lost returns the original batch', async (t) => {
  let lose = true;
  const h = await fixture(t, async (request, send) => {
    const state = await send(request);
    if (lose) {
      lose = false;
      throw Error('synthetic response lost');
    }
    return state;
  });
  const before = await h.read();
  await h.submit();
  assert.equal((await h.read()).batches.length, 1);
  assert.equal(h.button('确认登记').props.disabled, false);
  await h.submit();
  assert.deepEqual(h.requests[1], h.requests[0]);
  const after = await h.read();
  assert.equal(after.batches.length, 1);
  assert.deepEqual(cash(after), cash(before));
});

test('a committed batch with a lost response retries exactly once and changed content cannot acquire a new ID', async (t) => {
  let lose = true;
  const h = await fixture(t, async (request, send) => {
    const state = await send(request);
    if (lose) {
      lose = false;
      throw Error('synthetic response lost');
    }
    return state;
  });
  const before = await h.read();
  await h.submit();
  assert.equal((await h.read()).batches.length, 1);
  h.changeTotal('40.00');
  await h.submit();
  assert.equal(h.requests[1].requestId, h.requests[0].requestId);
  assert.equal((await h.read()).batches.length, 1);
  h.changeTotal('50.00');
  await h.submit();
  assert.deepEqual(h.requests[2], h.requests[0]);
  const after = await h.read();
  assert.equal(after.batches.length, 1);
  assert.deepEqual(cash(after), cash(before));
});

test('double submission is guarded synchronously while the first request is pending', async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await fixture(t, async (request, send) => {
      await blocked;
      return send(request);
    }),
    before = await h.read();
  const first = h.submit(),
    second = h.submit();
  assert.equal(h.requests.length, 1);
  release();
  await Promise.all([first, second]);
  const after = await h.read();
  assert.equal(after.batches.length, 1);
  assert.deepEqual(cash(after), cash(before));
});

test('retry revalidates current server allowance and local invalid allocations never send', async (t) => {
  let fail = true;
  const h = await fixture(t, async (request, send) => {
    if (fail) {
      fail = false;
      throw Error('synthetic transient failure');
    }
    return send(request);
  });
  const before = await h.read();
  await h.submit();
  await h.send({
    kind: 'batch',
    requestId: randomUUID(),
    date: '2026-10-16',
    allocations: [{ expenseId: 1, amount: 6000 }],
  });
  await h.submit();
  assert.equal(h.requests.length, 2);
  assert.equal((await h.read()).batches.length, 1);
  assert.deepEqual(h.requests[1], h.requests[0]);
  h.field('合成接待本次分配').props.onChange({ target: { value: '100.01' } });
  await h.submit();
  assert.equal(h.requests.length, 2);
  h.changeTotal('40.00');
  await h.submit();
  assert.equal(h.requests[2].requestId, h.requests[0].requestId);
  const after = await h.read();
  assert.equal(after.batches.length, 2);
  assert.deepEqual(cash(after), cash(before));
});
