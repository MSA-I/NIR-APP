import { useEffect, useRef, useState } from 'react';
import { MessageCircle, ImageDown, Share2 } from 'lucide-react';
import { Modal, Note, useToast } from './ui';
import { openOrderWhatsApp, shareOrderImage, canShareFiles, type WhatsAppOrder } from '../lib/share';
import { renderOrderImage, orderImageFileName } from '../lib/orderImage';

/**
 * The two-message WhatsApp send, as two explicit numbered steps (owner decision 18.08.2026):
 * step 1 opens wa.me with the priced-nothing text, step 2 hands over the order image — the
 * share sheet on platforms that can share files, an automatic download everywhere else.
 *
 * The image renders THE MOMENT the dialog opens, not when its button is clicked:
 * navigator.share({files}) must run inside an intact user activation, and an html2canvas render
 * between click and share burns it (Safari). Pre-rendered bytes make the step-2 click
 * synchronous. The preview doubles as proof — the operator sees exactly what the supplier gets.
 *
 * Nothing here touches order status: opening ≠ sending (share.ts:41-53); the call sites run
 * their existing human sent-confirmation after `onClose(openedText)`.
 */
export function WhatsAppSendDialog({ order, orgName, portalUrl, onClose }: {
  order: WhatsAppOrder | null;
  orgName: string;
  /** A freshly issued supplier-portal URL (0167) to ride inside the text message, if any. */
  portalUrl?: string | null;
  onClose: (openedText: boolean) => void;
}) {
  const toast = useToast();
  const [image, setImage] = useState<{ state: 'rendering' } | { state: 'ready'; blob: Blob; previewUrl: string } | { state: 'failed' }>({ state: 'rendering' });
  const openedTextRef = useRef(false);
  // Probe once: can this platform hand a PNG file to a share target at all?
  const filesSupported = useRef(canShareFiles([new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })])).current;

  useEffect(() => {
    if (!order) return;
    let alive = true;
    let url: string | null = null;
    openedTextRef.current = false;
    setImage({ state: 'rendering' });
    renderOrderImage(order, orgName)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setImage({ state: 'ready', blob, previewUrl: url });
      })
      .catch(() => { if (alive) setImage({ state: 'failed' }); });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [order, orgName]);

  if (!order) return null;

  function openText() {
    const res = openOrderWhatsApp(order!, orgName, portalUrl);
    if (res.error) { toast(res.error, 'error'); return; }
    openedTextRef.current = true;
  }

  async function sendImage() {
    if (image.state !== 'ready') return;
    const result = await shareOrderImage(image.blob, orderImageFileName(order!));
    if (result === 'downloaded') toast('התמונה נשמרה — גררו אותה לחלון ה-WhatsApp שנפתח וצרפו להודעה');
    else if (result === 'shared') toast('התמונה שותפה');
  }

  return (
    <Modal open title={`שליחת הזמנה #${order.number} ב-WhatsApp`} onClose={() => onClose(openedTextRef.current)}
      description="שני שלבים: הודעת טקסט, ואחריה תמונת ההזמנה המלאה.">
      <div className="space-y-4">
        <button className="btn-primary w-full justify-center" onClick={openText}>
          <MessageCircle size={16} /> 1. שליחת הודעת הטקסט
        </button>

        <button className="btn-secondary w-full justify-center" onClick={() => void sendImage()} disabled={image.state !== 'ready'}>
          {filesSupported ? <Share2 size={16} /> : <ImageDown size={16} />}
          {filesSupported ? '2. שיתוף תמונת ההזמנה' : '2. הורדת תמונת ההזמנה'}
        </button>
        {!filesSupported && image.state === 'ready' && (
          <p className="text-xs text-ink-muted">התמונה תישמר למחשב — גררו אותה לחלון ה-WhatsApp שנפתח וצרפו אותה להודעה.</p>
        )}

        {image.state === 'failed' && (
          <Note tone="await">לא ניתן היה להפיק את תמונת ההזמנה — ניתן לשלוח את הודעת הטקסט בלבד; היא כוללת את כל הפריטים.</Note>
        )}
        {image.state === 'rendering' && <p className="text-sm text-ink-muted" role="status">מכין את תמונת ההזמנה…</p>}
        {image.state === 'ready' && (
          <img src={image.previewUrl} alt={`תצוגה מקדימה של תמונת הזמנה #${order.number}`}
            className="w-full rounded-lg border border-line-soft" />
        )}

        <div className="flex justify-end">
          <button className="btn-ghost" onClick={() => onClose(openedTextRef.current)}>סיום</button>
        </div>
      </div>
    </Modal>
  );
}
