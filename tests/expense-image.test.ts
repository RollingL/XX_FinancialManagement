import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';
import { singleImage, validateImageFile, MAX_IMAGE_BYTES } from '../prototype/src/image-file.ts';

// Compile only this component in memory. External modules are explicit fakes;
// no ledger, browser, or user images are opened by these tests.
const bundle = await rolldown({
  input: fileURLToPath(new URL('../prototype/src/ExpenseScreenshot.tsx', import.meta.url)),
  external: () => true,
});
const compiled = await bundle.generate({ format: 'cjs', exports: 'named' });
await bundle.close();
const code = compiled.output[0].code;
const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
beforeEach(() =>
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value: async () => ({ width: 100, height: 100, close() {} }),
  }),
);
after(() => {
  if (bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, 'createImageBitmap');
});
const png = () =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'synthetic.png', {
    type: 'image/png',
  });
const jpeg = () =>
  new File([new Uint8Array([255, 216, 255, 224])], 'synthetic.jpg', { type: 'image/jpeg' });
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  return [value, ...nodes(value.props.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(value.props?.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function harness(
  options: {
    kind?: 'expense' | 'advance';
    disabled?: boolean;
    attachment?: boolean;
    validate?: typeof validateImageFile;
    read?: () => Promise<any>;
  } = {},
) {
  const slots: any[] = [],
    effects: Array<() => void> = [],
    cleanups = new Map<number, () => void>();
  let cursor = 0,
    tree: Node;
  const files: Array<File | null> = [],
    busy: boolean[] = [],
    created: string[] = [],
    revoked: string[] = [],
    reads: any[] = [];
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value: any) => {
          slots[index] = value;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => void | (() => void), deps: any[]) {
      const index = cursor++,
        prior = slots[index];
      if (!prior || deps.some((value, i) => value !== prior[i])) {
        slots[index] = deps;
        effects.push(() => {
          cleanups.get(index)?.();
          const cleanup = effect();
          if (cleanup) cleanups.set(index, cleanup);
        });
      }
    },
  };
  const jsx = (type: unknown, props: Record<string, any>): Node =>
    typeof type === 'function' ? type(props) : { type, props };
  const modules: Record<string, any> = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    './ImagePreview.tsx': ({ src, alt }: { src: string; alt: string }) => jsx('img', { src, alt }),
    './image-file.ts': { singleImage, validateImageFile: options.validate ?? validateImageFile },
    './ledger.ts': {
      ledgerCommand: (command: any) => {
        reads.push(command);
        return options.read?.() ?? Promise.resolve({ mime: 'image/png', base64: 'iVBORw0KGgo=' });
      },
    },
  };
  const exports: Record<string, any> = {};
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency ${name}`);
      return modules[name];
    },
    AbortController,
    Blob,
    Uint8Array,
    atob,
    URL: {
      createObjectURL: () => {
        const url = `blob:synthetic-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  });
  const props = {
    kind: options.kind ?? 'advance',
    disabled: options.disabled ?? false,
    onFile: (file: File | null) => files.push(file),
    onBusy: (value: boolean) => busy.push(value),
  };
  function render() {
    cursor = 0;
    tree = options.attachment
      ? exports.ExpenseAttachment({ id: 'synthetic-original', kind: props.kind })
      : exports.default(props);
    while (effects.length) effects.shift()!();
    return tree;
  }
  function find(type: string, label?: string) {
    render();
    const found = nodes(tree).find(
      (node) => node.type === type && (label === undefined || text(node) === label),
    );
    assert.ok(found, `Missing ${type} ${label ?? ''}`);
    return found;
  }
  render();
  return {
    files,
    busy,
    created,
    revoked,
    reads,
    props,
    render,
    find,
    pick(selected: File[]) {
      find('input').props.onChange({ target: { files: selected, value: 'selected' } });
    },
    drop(selected: File[]) {
      let prevented = 0,
        stopped = 0;
      render().props.onDrop({
        dataTransfer: { files: selected },
        preventDefault() {
          prevented++;
        },
        stopPropagation() {
          stopped++;
        },
      });
      assert.equal(prevented, 1);
      assert.equal(stopped, 1);
    },
    unmount() {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
  };
}

test('到账截图是可选上传，不会自动填写金额', () => {
  const h = harness();
  assert.equal(h.render().props['aria-label'], '到账截图');
  assert.equal(text(h.find('label')), '上传到账截图（可选）');
  assert.equal(h.find('input').props.type, 'file');
  assert.equal(h.find('input').props.accept, 'image/png,image/jpeg');
  assert.match(text(h.render()), /不会自动填写金额/);
  h.unmount();
});

test('到账截图选择 PNG/JPEG 仅回传附件，替换和移除释放 URL 且不清空文字', async () => {
  const h = harness(),
    first = png(),
    second = jpeg();
  h.pick([first]);
  await settle();
  assert.equal(h.files[0], first);
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(h.find('img').props.alt, '待保存预支的到账截图原图');
  h.pick([second]);
  await settle();
  assert.equal(h.files[1], second);
  assert.deepEqual(h.revoked, ['blob:synthetic-0']);
  h.find('button', '移除到账截图').props.onClick();
  assert.equal(h.files.at(-1), null);
  assert.deepEqual(h.revoked, ['blob:synthetic-0', 'blob:synthetic-1']);
  assert.equal(h.reads.length, 0);
  assert.equal(
    nodes(h.render()).some((node) => node.type === 'img'),
    false,
  );
  h.unmount();
});

test('到账截图拖拽阻止文件导航，校验忙碌期间的重复拖拽不会打断请求', async () => {
  const gate = deferred<void>();
  let checks = 0;
  const h = harness({
      validate: async () => {
        checks++;
        await gate.promise;
      },
    }),
    image = png();
  h.drop([image]);
  h.drop([png()]);
  assert.equal(checks, 1);
  assert.equal(h.find('input').props.disabled, true);
  assert.equal(h.files.length, 0);
  gate.resolve();
  await settle();
  assert.equal(h.files[0], image);
  assert.deepEqual(h.busy, [true, false]);
  h.unmount();
  assert.deepEqual(h.revoked, h.created);
});

test('截图点击和拖拽拒绝多图、非图片、超限大小、伪造签名及超限像素', async (t) => {
  const h = harness(),
    large = png();
  Object.defineProperty(large, 'size', { value: MAX_IMAGE_BYTES + 1 });
  for (const files of [
    [png(), png()],
    [new File(['%PDF'], 'synthetic.pdf', { type: 'application/pdf' })],
    [large],
  ]) {
    h.drop(files);
    await settle();
    assert.equal(h.files.length, 0);
  }
  h.pick([new File(['invalid'], 'synthetic.png', { type: 'image/png' })]);
  await settle();
  assert.match(text(h.render()), /格式无效/);
  t.mock.method(
    globalThis,
    'createImageBitmap',
    async () => ({ width: 5000, height: 4001, close() {} }) as ImageBitmap,
  );
  h.pick([png()]);
  await settle();
  assert.match(text(h.render()), /2000 万像素/);
  assert.equal(h.files.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal(h.busy.at(-1), false);
  h.unmount();
});

test('禁用入口不开始校验，卸载后迟到的校验不能回写或创建预览', async () => {
  const gate = deferred<void>();
  let checks = 0,
    signal: AbortSignal | undefined;
  const validate = async (_file: File, value?: AbortSignal) => {
    checks++;
    signal = value;
    await gate.promise;
  };
  const disabled = harness({ disabled: true, validate });
  disabled.drop([png()]);
  disabled.pick([png()]);
  assert.equal(checks, 0);
  disabled.unmount();
  const h = harness({ validate });
  h.drop([png()]);
  h.unmount();
  assert.equal(signal?.aborted, true);
  gate.resolve();
  await settle();
  assert.equal(h.files.length, 0);
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.busy, [true, false]);
});

test('费用截图和到账截图一样只回传附件，提示手动填写', async () => {
  const expense = harness({ kind: 'expense' }),
    image = png();
  assert.equal(expense.render().props['aria-label'], '支付截图');
  expense.pick([image]);
  await settle();
  assert.equal(expense.files[0], image);
  assert.deepEqual(expense.busy, [true, false]);
  assert.equal(expense.find('img').props.alt, '待保存费用的支付截图原图');
  assert.match(text(expense.render()), /手动填写金额、日期和商户/);
  expense.find('button', '移除支付截图').props.onClick();
  assert.equal(expense.files.at(-1), null);
  assert.equal(expense.reads.length, 0);
  expense.unmount();
  assert.deepEqual(expense.revoked, expense.created);
});

test('已保存到账附件只调用附件读取，标题/alt 清楚且卸载释放 URL', async () => {
  const h = harness({ attachment: true });
  await settle();
  assert.equal(h.find('h3').props.children.join(''), '到账截图附件');
  assert.equal(h.find('img').props.alt, '该笔预支已保留的到账截图');
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].kind, 'attachment');
  assert.equal(h.reads[0].id, 'synthetic-original');
  h.unmount();
  assert.deepEqual(h.revoked, h.created);
  const late = deferred<any>(),
    pending = harness({ attachment: true, read: () => late.promise });
  pending.unmount();
  late.resolve({ mime: 'image/png', base64: 'iVBORw0KGgo=' });
  await settle();
  assert.equal(pending.created.length, 0);
});
