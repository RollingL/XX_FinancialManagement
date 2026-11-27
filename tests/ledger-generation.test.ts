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
  return (await import(`../src/renderer/ledger.ts?case=${Math.random()}`)).ledgerCommand;
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
  const { ledgerCommand } = await import(`../src/renderer/ledger.ts?case=${Math.random()}`);
  await ledgerCommand({ kind: 'read' });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      ledgerCommand({ kind: 'expense', requestId: 'same-request' }),
      /账本已清空/,
    );
  assert.deepEqual(inputs[1], inputs[2]);
  assert.equal(inputs[1].generation, 'old-http-generation');
});

test('desktop refusals show only the reason, without the bridge wording', async (t) => {
  const command = await client(t, async (input) => {
    if (input.kind === 'read') return empty('generation-one');
    throw Error("Error invoking remote method 'ledger:command': Error: 金额必须大于 0");
  });
  await command({ kind: 'read' });
  await assert.rejects(command({ kind: 'expense', requestId: 'synthetic' }), (error: Error) => {
    assert.equal(error.message, '金额必须大于 0');
    return true;
  });
  const { plainMessage } = await import('../src/renderer/ledger.ts');
  assert.equal(plainMessage(Error('普通原因')), '普通原因');
  assert.equal(plainMessage(Error("Error invoking remote method 'x': ")), '本地读写失败，请重试');
});

test('a save refused as out of date reads the ledger again and says so instead of asking to refresh', async (t) => {
  const seen: string[] = [];
  let reads = 0,
    last: any;
  await client(t, async (input) => {
    seen.push(input.kind);
    last = input;
    if (input.kind === 'read') return empty(`generation-${++reads}`);
    if (input.kind === 'expense') throw Error('金额必须大于 0');
    throw Error(
      "Error invoking remote method 'ledger:command': Error: 费用已变化，请刷新后重新核对",
    );
  });
  const ledger = await import(`../src/renderer/ledger.ts?case=${Math.random()}`);
  const reloaded: any[] = [];
  const stop = ledger.onLedgerReloaded((state: any) => reloaded.push(state));
  await ledger.ledgerCommand({ kind: 'read' });
  await assert.rejects(
    ledger.ledgerCommand({ kind: 'correct-expense', requestId: 'synthetic' }),
    (error: Error) => {
      assert.equal(error.message, '费用已变化。已重新读取最新账本，请核对后再保存。');
      return true;
    },
  );
  assert.deepEqual(seen, ['read', 'correct-expense', 'read']);
  assert.deepEqual(reloaded, [empty('generation-2')]);
  // The next save carries the generation that was just read.
  await assert.rejects(ledger.ledgerCommand({ kind: 'expense', requestId: 'next' }), /金额/);
  assert.equal(last.generation, 'generation-2');
  // Other refusals are passed on as they are, without reading again.
  assert.equal(seen.filter((kind) => kind === 'read').length, 2);
  stop();
  await assert.rejects(ledger.ledgerCommand({ kind: 'correct-expense', requestId: 'x' }));
  assert.equal(reloaded.length, 1, 'a stopped listener is not told again');
});
