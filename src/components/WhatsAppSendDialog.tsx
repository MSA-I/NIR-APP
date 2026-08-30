import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { ImageDown, Loader2, Send, Share2 } from 'lucide-react';
import { ICON, Modal, Note, useToast } from './ui';
import { OPEN_ORDER_WHATSAPP_ERROR_KEY, openOrderWhatsApp, shareOrderImage, canShareFiles, type WhatsAppOrder } from '../lib/share';
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
 *
 * THIS IS THE MANUAL CHANNEL, AND IT SAYS SO. Since 0191 an organization may also connect its
 * own WhatsApp sender and have the provider report delivery (#239, #240). The two must never be
 * confused: opening wa.me is a person promising a message left, and no provider ever confirms
 * it. The banner below is that distinction made visible, so a manual share can never be read --
 * by a manager or by a later feature -- as verified provider delivery.
 */
export function WhatsAppSendDialog({ order, orgName, portalUrl, onClose }: {
  order: WhatsAppOrder | null;
  orgName: string;
  /** A freshly issued supplier-portal URL (0167) to ride inside the text message, if any. */
  portalUrl?: string | null;
  onClose: (openedText: boolean) => void;
}) {
  const { t } = useT();
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
    if (res.errorCode) {
      toast(t(OPEN_ORDER_WHATSAPP_ERROR_KEY[res.errorCode]), 'error');
      return;
    }
    openedTextRef.current = true;
  }

  async function sendImage() {
    if (image.state !== 'ready') return;
    const result = await shareOrderImage(image.blob, orderImageFileName(order!));
    if (result === 'downloaded') toast(t('whatsAppSendDialog.savedInstructions'));
    else if (result === 'shared') toast(t('whatsAppSendDialog.shared'));
  }

  return (
    <Modal open title={t('whatsAppSendDialog.title', { number: order.number })} onClose={() => onClose(openedTextRef.current)}
      description={t('whatsAppSendDialog.description')}>
      <div className="space-y-4">
        <Note tone="idle">
          <span className="min-w-0 flex-1">
            {t('whatsAppSendDialog.manualDeliveryNote')}
          </span>
        </Note>

        <button className="btn-primary w-full" onClick={openText}>
          <Send size={ICON.sm} aria-hidden="true" /> {t('whatsAppSendDialog.sendText')}
        </button>

        <button className="btn-secondary w-full" onClick={() => void sendImage()} disabled={image.state !== 'ready'}>
          {/* DESIGN.md:554 — a button that is not yet actionable says so inside itself, rather
              than only greying out and leaving the explanation to a paragraph below. */}
          {image.state === 'rendering'
          ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />
            : filesSupported ? <Share2 size={ICON.sm} aria-hidden="true" /> : <ImageDown size={ICON.sm} aria-hidden="true" />}
          {filesSupported ? t('whatsAppSendDialog.shareImage') : t('whatsAppSendDialog.downloadImage')}
        </button>
        {!filesSupported && image.state === 'ready' && (
          <p className="text-xs text-ink-muted">{t('whatsAppSendDialog.downloadInstructions')}</p>
        )}

        {image.state === 'failed' && (
          <Note tone="await">{t('whatsAppSendDialog.imageFailed')}</Note>
        )}
        {image.state === 'rendering' && <p className="text-sm text-ink-muted" role="status">{t('whatsAppSendDialog.renderingImage')}</p>}
        {image.state === 'ready' && (
          <img src={image.previewUrl} alt={t('whatsAppSendDialog.previewAlt', { number: order.number })}
            className="w-full rounded-lg border border-line-soft" />
        )}

        <div className="flex justify-end">
          <button className="btn-ghost" onClick={() => onClose(openedTextRef.current)}>{t('whatsAppSendDialog.done')}</button>
        </div>
      </div>
    </Modal>
  );
}
