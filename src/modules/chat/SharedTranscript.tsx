import { useMemo } from 'react';

import type { ChatMessage, NormalizedMessage } from '@/shared/types';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';

type SharedTranscriptProps = {
  shareId: string;
  /** The history as the owner's server froze it (the same messages GET /sessions/:id/messages returns). */
  messages: NormalizedMessage[];
  showThinking?: boolean;
};

const keyOf = (message: ChatMessage): string => getIntrinsicMessageKey(message) ?? 'message-generated';

/**
 * A shared conversation's messages, drawn by the same components as a conversation of one's own (messages with their
 * images, tool steps, sent-file cards), with nothing to act on: no edit, no fork, no permission prompts. Sent files
 * load from the share (TranscriptSessionContext's shareId).
 */
export default function SharedTranscript({ shareId, messages, showThinking = false }: SharedTranscriptProps) {
  const chatMessages = useMemo(() => normalizedToChatMessages(messages), [messages]);
  const items = useMemo(() => groupConsecutiveTools(chatMessages, showThinking), [chatMessages, showThinking]);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const context = useMemo(() => ({ sessionId: null, shareId }), [shareId]);

  // each row with the row before it (grouping and spacing depend on it) and a key unique on the page
  const rows = useMemo(() => {
    const seen = new Map<string, number>();
    const unique = (key: string) => {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return n === 0 ? key : `${key}__${n}`;
    };
    let prev: ChatMessage | null = null;
    return items.map((item) => {
      const before = prev;
      if (isToolGroupItem(item)) {
        prev = item.messages[item.messages.length - 1] || prev;
        return { item, prev: before, key: unique(`tool-group-${keyOf(item.messages[0]!)}`) };
      }
      prev = item;
      return { item, prev: before, key: unique(keyOf(item)) };
    });
  }, [items]);

  return (
    <TranscriptSessionContext.Provider value={context}>
      <div className="space-y-3 sm:space-y-4">
        {rows.map(({ item, prev, key }) =>
          isToolGroupItem(item) ? (
            <ToolGroupContainer
              key={key}
              group={item}
              prevMessage={prev}
              createDiff={createDiff}
              getMessageKey={keyOf}
              showThinking={showThinking}
              provider="claude"
            />
          ) : (
            <MessageComponent
              key={key}
              message={item}
              prevMessage={prev}
              createDiff={createDiff}
              showThinking={showThinking}
              provider="claude"
            />
          ),
        )}
      </div>
    </TranscriptSessionContext.Provider>
  );
}
