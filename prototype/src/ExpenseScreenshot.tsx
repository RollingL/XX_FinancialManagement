import React, { useEffect, useRef, useState } from 'react';
import { ledgerCommand } from './ledger.ts';
import { singleImage, validateImageFile } from './image-file.ts';
import ImagePreview from './ImagePreview.tsx';

type ScreenshotKind = 'expense' | 'advance';

// Lets the user attach one PNG / JPEG as evidence. The picture is only kept
// with the record when the form is saved; nothing is read from it.
export default function ExpenseScreenshot({
  kind = 'expense',
  onFile,
  onBusy,
  disabled,
}: {
  kind?: ScreenshotKind;
  onFile: (file: File | null) => void;
  onBusy: (value: boolean) => void;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false);
  const controller = useRef<AbortController | null>(null),
    previewUrl = useRef(''),
    input = useRef<HTMLInputElement>(null),
    handlers = useRef({ onFile, onBusy });
  handlers.current = { onFile, onBusy };
  const advance = kind === 'advance',
    label = advance ? '到账截图' : '支付截图';

  useEffect(
    () => () => {
      const pending = controller.current;
      controller.current = null;
      pending?.abort();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      handlers.current.onBusy(false);
    },
    [],
  );

  function showPreview(url: string) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = url;
    setPreview(url);
  }

  function clear() {
    if (disabled || controller.current) return;
    onFile(null);
    showPreview('');
    setMessage('');
    if (input.current) input.current.value = '';
  }

  async function upload(files: File[]) {
    // The ref also blocks a second drop before React has rendered the busy state.
    if (disabled || controller.current) return;
    let file: File;
    try {
      file = singleImage(files);
    } catch (e) {
      setMessage((e as Error).message);
      return;
    }
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    onBusy(true);
    setMessage('正在检查图片…');
    try {
      await validateImageFile(file, request.signal);
      if (controller.current !== request || request.signal.aborted) return;
      showPreview(URL.createObjectURL(file));
      handlers.current.onFile(file);
      setMessage(
        advance
          ? '到账截图已准备好，保存预支时才会一起保留；请手动填写到账金额和日期。'
          : '支付截图已准备好，保存费用时才会一起保留；请对照截图手动填写金额、日期和商户。',
      );
    } catch (e) {
      if (controller.current === request && !request.signal.aborted)
        setMessage((e as Error).message);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
        handlers.current.onBusy(false);
      }
    }
  }

  function dragOver(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || busy ? 'none' : 'copy';
    if (!disabled && !controller.current) setDragging(true);
  }

  function drop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    void upload(Array.from(event.dataTransfer.files));
  }

  return (
    <section
      className={`expense-screenshot${dragging ? ' dragging' : ''}`}
      aria-label={label}
      aria-busy={busy}
      onDragOver={dragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <label className="field">
        上传{label}（可选）
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          disabled={disabled || busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
      </label>
      <p className="help">
        点击选择或拖入单张 PNG / JPEG，最大 20 MiB、2000 万像素；不支持 PDF、SVG 或多图。
        截图只作为凭证保存，不会自动填写金额。
      </p>
      {message && (
        <p role="status" className="help">
          {message}
        </p>
      )}
      {preview && (
        <>
          <div className="screenshot-actions">
            <button type="button" disabled={disabled || busy} onClick={clear}>
              移除{label}
            </button>
          </div>
          <ImagePreview
            key={preview}
            src={preview}
            alt={`待保存${advance ? '预支的到账' : '费用的支付'}截图原图`}
          />
        </>
      )}
    </section>
  );
}

export function ExpenseAttachment({ id, kind = 'expense' }: { id: string; kind?: ScreenshotKind }) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState('');
  const label = kind === 'advance' ? '到账截图' : '支付截图';
  useEffect(() => {
    let active = true,
      objectUrl = '';
    setUrl('');
    setError('');
    ledgerCommand<{ mime: string; base64: string }>({ kind: 'attachment', id })
      .then((data) => {
        if (!active) return;
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setError('附件读取失败，请保留现有数据并重试。');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  return (
    <section aria-label={`已保存的${label}`}>
      <h3>{label}附件</h3>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : url ? (
        <ImagePreview
          key={url}
          src={url}
          alt={`该笔${kind === 'advance' ? '预支' : '费用'}已保留的${label}`}
        />
      ) : (
        <p role="status">正在读取附件…</p>
      )}
    </section>
  );
}
