import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download, ExternalLink, File, FileImage, FileText, RefreshCw, X } from 'lucide-react';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';
import { useSessionFiles, type SessionFile } from '@/modules/jarvis-files/useSessionFiles';
import {
  fileDirectory,
  fileName,
  formatFileSize,
  previewKind,
} from '@/modules/jarvis-files/filePreview';

type JarvisFilesPanelProps = {
  open: boolean;
  /** The open conversation; null for a new chat that has not started yet. */
  sessionId: string | null;
  /** A file to show straight away (a file the chat linked to), relative to the workspace. */
  initialPath: string | null;
  onClose: () => void;
};

const iconFor = (file: SessionFile) => {
  const kind = previewKind(file.path, file.size);
  if (kind === 'image') return FileImage;
  if (kind === 'pdf' || kind === 'text') return FileText;
  return File;
};

/**
 * The staff build's Files sheet (WorkspaceMain renders it): the open conversation's workspace files,
 * newest first, each with a download and, for images, PDFs and small text files, a preview. Full
 * screen on a phone, a panel on the right on a wider screen.
 */
export default function JarvisFilesPanel({ open, sessionId, initialPath, onClose }: JarvisFilesPanelProps) {
  const { t, i18n } = useTranslation('jarvis');
  const { files, isLoading, error, reload } = useSessionFiles(sessionId, open);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);

  useEffect(() => {
    if (open) setSelectedPath(initialPath);
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const selectedFile = selectedPath
    ? files.find((file) => file.path === selectedPath) ?? { path: selectedPath, size: 0, mtime: 0 }
    : null;
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t('files.title')}>
      <button
        type="button"
        className="absolute inset-0 hidden bg-background/60 backdrop-blur-sm sm:block"
        onClick={onClose}
        aria-label={t('files.close')}
      />
      <div className="pwa-header-safe relative flex h-full w-full flex-col border-l border-border/60 bg-background shadow-xl sm:max-w-md lg:max-w-xl">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          {selectedFile ? (
            <button
              type="button"
              onClick={() => setSelectedPath(null)}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('files.back')}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {selectedFile ? fileName(selectedFile.path) : t('files.title')}
          </h2>
          {selectedFile && sessionId ? (
            <a
              href={api.jarvis.sessionFileRawUrl(sessionId, selectedFile.path)}
              download={fileName(selectedFile.path)}
              className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary hover:bg-accent"
            >
              <Download className="h-4 w-4" />
              {t('files.download')}
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void reload()}
              disabled={!sessionId || isLoading}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              aria-label={t('files.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('files.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {selectedFile && sessionId ? (
            <FilePreview sessionId={sessionId} file={selectedFile} />
          ) : !sessionId ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.notStarted')}</p>
          ) : error ? (
            <div className="px-4 py-10 text-center text-sm">
              <p className="mb-3 text-muted-foreground">{t('files.loadError')}</p>
              <button type="button" onClick={() => void reload()} className="font-medium text-primary hover:underline">
                {t('files.retry')}
              </button>
            </div>
          ) : isLoading && files.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.loading')}</p>
          ) : files.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.empty')}</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {files.map((file) => {
                const Icon = iconFor(file);
                const directory = fileDirectory(file.path);
                const modified = new Date(file.mtime);
                return (
                  <li key={file.path} className="flex items-center gap-1 pr-2">
                    <button
                      type="button"
                      onClick={() => setSelectedPath(file.path)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
                    >
                      <Icon className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{fileName(file.path)}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[directory, formatFileSize(file.size), Number.isNaN(modified.getTime()) ? '' : dateFormat.format(modified)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                    <a
                      href={api.jarvis.sessionFileRawUrl(sessionId, file.path)}
                      download={fileName(file.path)}
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t('files.downloadNamed', { name: fileName(file.path) })}
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function FilePreview({ sessionId, file }: { sessionId: string; file: SessionFile }) {
  const { t } = useTranslation('jarvis');
  const kind = previewKind(file.path, file.size);
  const inlineUrl = api.jarvis.sessionFileRawUrl(sessionId, file.path, { inline: true });
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    if (kind !== 'text') return undefined;
    const controller = new AbortController();
    setText(null);
    setTextError(false);
    fetch(api.jarvis.sessionFileRawUrl(sessionId, file.path), { signal: controller.signal, cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(setText)
      .catch(() => {
        if (!controller.signal.aborted) setTextError(true);
      });
    return () => controller.abort();
  }, [file.path, kind, sessionId]);

  if (kind === 'image') {
    return (
      <div className="flex min-h-full items-center justify-center bg-muted/30 p-3">
        <img src={inlineUrl} alt={fileName(file.path)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <div className="flex h-full flex-col">
        <iframe src={inlineUrl} title={fileName(file.path)} className="min-h-0 w-full flex-1 border-0 bg-muted/30" />
        <a
          href={inlineUrl}
          target="_blank"
          rel="noreferrer"
          className="flex flex-shrink-0 items-center justify-center gap-1.5 border-t border-border/60 py-2.5 text-sm font-medium text-primary hover:bg-accent/50"
        >
          <ExternalLink className="h-4 w-4" />
          {t('files.openInNewTab')}
        </a>
      </div>
    );
  }

  if (kind === 'text') {
    if (textError) {
      return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.loadError')}</p>;
    }
    if (text === null) {
      return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('files.loading')}</p>;
    }
    return (
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">{text}</pre>
    );
  }

  return (
    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
      <File className="mx-auto mb-3 h-10 w-10" />
      <p>{t('files.noPreview')}</p>
    </div>
  );
}
