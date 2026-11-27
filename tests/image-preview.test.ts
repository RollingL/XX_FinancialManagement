import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';

const bundle = await rolldown({
  input: fileURLToPath(new URL('../prototype/src/ImagePreview.tsx', import.meta.url)),
  external: () => true,
});
const compiled = await bundle.generate({ format: 'cjs', exports: 'named' });
await bundle.close();
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: any): Node[] {
  return Array.isArray(value)
    ? value.flatMap(nodes)
    : value?.props
      ? [value, ...nodes(value.props.children)]
      : [];
}

test('完整预览保留图片 URL，键盘取消只关闭图片，恢复触发按钮焦点', () => {
  const refs: any[] = [],
    exports: Record<string, any> = {};
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  runInNewContext(compiled.output[0].code, {
    exports,
    require: (name: string) => {
      if (name === 'react')
        return {
          useId: () => ':synthetic-preview:',
          useRef: (value: any) => {
            const ref = { current: value };
            refs.push(ref);
            return ref;
          },
        };
      assert.equal(name, 'react/jsx-runtime');
      return { jsx, jsxs: jsx, Fragment: 'fragment' };
    },
  });
  const tree = nodes(exports.default({ src: 'blob:synthetic-original', alt: '合成原图' }));
  const dialog = tree.find((node) => node.type === 'dialog')!,
    buttons = tree.filter((node) => node.type === 'button');
  let opened = 0,
    closed = 0,
    focused = 0,
    stopped = 0,
    prevented = 0;
  refs[0].current = {
    showModal() {
      opened++;
    },
    close() {
      closed++;
    },
  };
  refs[1].current = {
    focus() {
      focused++;
    },
  };
  assert.equal(buttons[0].props['aria-haspopup'], 'dialog');
  buttons[0].props.onClick();
  assert.equal(opened, 1);
  assert.equal(dialog.props['aria-labelledby'], tree.find((node) => node.type === 'h2')!.props.id);
  for (const img of tree.filter((node) => node.type === 'img')) {
    assert.equal(img.props.src, 'blob:synthetic-original');
    assert.equal(img.props.alt, '合成原图');
  }
  dialog.props.onCancel({
    preventDefault() {
      prevented++;
    },
    stopPropagation() {
      stopped++;
    },
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  dialog.props.onClose({
    stopPropagation() {
      stopped++;
    },
  });
  assert.equal(stopped, 2);
  assert.equal(focused, 1);
  buttons[1].props.onClick();
  assert.equal(closed, 2);
  const backdrop = {};
  dialog.props.onClick({
    target: {},
    currentTarget: backdrop,
    stopPropagation() {
      stopped++;
    },
  });
  assert.equal(closed, 2);
  dialog.props.onClick({
    target: backdrop,
    currentTarget: backdrop,
    stopPropagation() {
      stopped++;
    },
  });
  assert.equal(closed, 3);
});
