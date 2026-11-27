import { useId, useRef } from 'react';

/** Only local image object URLs from validated uploads or managed attachments are passed here. */
export default function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    title = useId();
  function close() {
    dialog.current?.close();
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="receipt-preview"
        aria-label={`查看完整图片：${alt}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <img src={src} alt={alt} />
        <span>点击查看完整图片</span>
      </button>
      <dialog
        ref={dialog}
        className="image-preview-dialog"
        aria-labelledby={title}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onClose={(event) => {
          event.stopPropagation();
          trigger.current?.focus();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="image-preview-content">
          <header>
            <h2 id={title}>完整图片预览</h2>
            <button type="button" autoFocus onClick={close} aria-label="关闭完整图片预览">
              关闭
            </button>
          </header>
          <div className="image-preview-scroll" tabIndex={0} aria-label="完整图片，可滚动查看">
            <img src={src} alt={alt} />
          </div>
          <p className="help">按 Esc 或点击关闭返回。长图可滚动查看。</p>
        </div>
      </dialog>
    </>
  );
}
