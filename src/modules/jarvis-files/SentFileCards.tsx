import { useTranslation } from 'react-i18next';
import { Download, File, FileImage, FileText } from 'lucide-react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';
import { JARVIS_WORKSPACE_PATH } from '@/shared/jarvis';
import { fileName, formatFileSize, previewKind } from '@/modules/jarvis-files/filePreview';
import { readSendUserFileInput, sentFilesOf } from '@/modules/jarvis-files/sentFiles';
import { useTranscriptShareId } from '@/modules/chat/context/TranscriptSessionContext';

type SentFileCardsProps = {
  sessionId: string | null;
  toolInput: unknown;
  toolResult?: { isError?: boolean; toolUseResult?: unknown } | null;
  /** Opens a file in the Files panel (an absolute /workspace path). */
  onOpen?: (filePath: string) => void;
};

/**
 * The staff build's rendering of a SendUserFile call: the caption, then one card per file (images and PDFs with a
 * preview unless Claude asked to attach only), each with its name, size and a download. Same look as the previous
 * YYC AI frontend's presented-file cards. Until the tool has run the cards show as being sent.
 */
export default function SentFileCards({ sessionId, toolInput, toolResult, onOpen }: SentFileCardsProps) {
  const { t } = useTranslation('jarvis');
  // on a shared page the bytes come from the share's snapshot, not the owner's conversation
  const shareId = useTranscriptShareId();
  const rawUrl = (filePath: string, options?: { inline?: boolean }) =>
    shareId ? api.jarvis.shareFileRawUrl(shareId, filePath, options) : sessionId ? api.jarvis.sessionFileRawUrl(sessionId, filePath, options) : '';
  const canLoad = Boolean(shareId || sessionId);
  const input = readSendUserFileInput(toolInput);
  const files = sentFilesOf(input, toolResult?.toolUseResult);
  const pending = !toolResult;
  if (files.length === 0 && !input.caption) return null;

  return (
    <div className="my-1 flex flex-col gap-2" data-testid="sent-files">
      {input.caption && (
        <p dir="auto" className="m-0 font-serif text-sm text-gray-700 dark:text-gray-300">
          {input.caption}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        {files.map((file) => {
          const name = fileName(file.path);
          const kind = previewKind(file.path, file.size ?? 0);
          const showPreview = !pending && canLoad && input.display !== 'attach' && (kind === 'image' || kind === 'pdf');
          const inlineUrl = rawUrl(file.path, { inline: true });
          const Icon = kind === 'image' ? FileImage : kind === 'pdf' || kind === 'text' ? FileText : File;
          const open = () => onOpen?.(`${JARVIS_WORKSPACE_PATH}/${file.path}`);
          return (
            <div
              key={file.path}
              className={cn('flex min-w-0 flex-col gap-1.5', kind === 'image' ? 'max-w-[min(100%,360px)]' : 'max-w-[min(100%,280px)]')}
            >
              {showPreview && (
                <button
                  type="button"
                  onClick={open}
                  className="block overflow-hidden rounded-[10px] border border-border bg-muted/40 text-left"
                  aria-label={t('sent.open', { name })}
                >
                  {kind === 'image' ? (
                    <img src={inlineUrl} alt={name} loading="lazy" className="block max-h-80 w-full object-contain" />
                  ) : (
                    <iframe
                      src={`${inlineUrl}#toolbar=0&navpanes=0&view=FitH`}
                      title={name}
                      tabIndex={-1}
                      className="pointer-events-none block h-52 w-[260px] max-w-full border-0 bg-white"
                    />
                  )}
                </button>
              )}
              <div
                className={cn(
                  'inline-flex max-w-full items-center gap-2 self-start rounded-[10px] border bg-background px-3 py-1.5 text-sm text-foreground',
                  'border-primary/40',
                )}
              >
                <button
                  type="button"
                  onClick={open}
                  disabled={pending || !onOpen}
                  className="flex min-w-0 items-center gap-2 text-left hover:underline disabled:no-underline"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-primary" />
                  <span className="min-w-0 truncate">{name}</span>
                </button>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {pending ? t('sent.sending') : file.size !== null ? formatFileSize(file.size) : ''}
                </span>
                {!pending && canLoad && (
                  <a
                    href={rawUrl(file.path)}
                    download={name}
                    className="-mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t('files.downloadNamed', { name })}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
