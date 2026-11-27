import test from 'node:test';
import assert from 'node:assert/strict';

async function client(t: any, command: (input: any) => Promise<any>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { localLedger: { command } },
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return (await import(`../prototype/src/ledger.ts?case=${Math.random()}`)).ledgerCommand;
}
const empty = (generation?: string) => ({
  expenses: [],
  batches: [],
  advances: [],
  ...(generation ? { generation } : {}),
});

test('maintenance information cannot refresh an old tab generation or mutate its queued draft', async (t) => {
  const seen: any[] = [];
  const command = await client(t, async (input) => {
    seen.push(input);
    return input.kind === 'read'
      ? empty('generation-one')
      : input.kind === 'maintenance-info'
        ? { generation: 'generation-two' }
        : empty('generation-one');
  });
  await command({ kind: 'read' });
  await command({ kind: 'maintenance-info' });
  const draft = Object.freeze({
    kind: 'expense',
    requestId: 'synthetic-request',
    expense: { amount: 1 },
  });
  await command(draft);
  await command(draft);
  assert.equal(seen[2].generation, 'generation-one');
  assert.deepEqual(seen[2], seen[3]);
  assert.equal(Object.hasOwn(draft, 'generation'), false);
});

test('explicit pending reset generation is retained and only a fresh read renews the tab token', async (t) => {
  const seen: any[] = [];
  let readCount = 0;
  const command = await client(t, async (input) => {
    seen.push(input);
    return input.kind === 'read'
      ? empty(++readCount === 1 ? 'old-generation' : 'new-generation')
      : empty('new-generation');
  });
  await command({ kind: 'read' });
  await command({ kind: 'reset-ledger', generation: 'pending-generation' });
  assert.equal(seen.at(-1).generation, 'pending-generation');
  await command({ kind: 'batch' });
  assert.equal(seen.at(-1).generation, 'old-generation');
  await command({ kind: 'read' });
  await command({ kind: 'batch' });
  assert.equal(seen.at(-1).generation, 'new-generation');
});

test('unmanaged legacy ledgers keep their original command shape', async (t) => {
  const seen: any[] = [];
  const command = await client(t, async (input) => {
    seen.push(input);
    return empty();
  });
  await command({ kind: 'read' });
  await command({ kind: 'advance', requestId: 'synthetic' });
  assert.deepEqual(seen.at(-1), { kind: 'advance', requestId: 'synthetic' });
});

test('HTTP transport retains source protections and the old token after a failed save', async (t) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    priorFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  const inputs: any[] = [];
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  globalThis.fetch = async (url: any, options: any) => {
    assert.equal(url, '/api/ledger');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Ledger-Request'], '1');
    assert.equal(options.cache, 'no-store');
    const input = JSON.parse(options.body);
    inputs.push(input);
    return new Response(
      JSON.stringify(
        input.kind === 'read' ? empty('old-http-generation') : { error: '账本已清空，请刷新' },
      ),
      {
        status: input.kind === 'read' ? 200 : 409,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const { ledgerCommand } = await import(`../prototype/src/ledger.ts?case=${Math.random()}`);
  await ledgerCommand({ kind: 'read' });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      ledgerCommand({ kind: 'expense', requestId: 'same-request' }),
      /账本已清空/,
    );
  assert.deepEqual(inputs[1], inputs[2]);
  assert.equal(inputs[1].generation, 'old-http-generation');
});
