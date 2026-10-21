import {useMemo, useState, type SetStateAction} from 'react';
import type {AIImage, TextFileAttachment} from '../../shared/contracts';
import type {ComposerReference} from './composerMentionState';

export type ComposerDraft = {
  message: string;
  references: ComposerReference[];
  images: AIImage[];
  files: TextFileAttachment[];
  ignoreProjectMemory: boolean;
};
const emptyDraft: ComposerDraft = {message: '', references: [], images: [], files: [], ignoreProjectMemory: false};
export type SessionDrafts = ReadonlyMap<string | null, ComposerDraft>;
export function sessionDraft(drafts: SessionDrafts, session: string | null): ComposerDraft {
  return drafts.get(session) ?? emptyDraft;
}
export function updateSessionDraft<K extends keyof ComposerDraft>(drafts: SessionDrafts, session: string | null, field: K, value: SetStateAction<ComposerDraft[K]>): SessionDrafts {
  const current = sessionDraft(drafts, session);
  const next = typeof value === 'function' ? (value as (previous: ComposerDraft[K]) => ComposerDraft[K])(current[field]) : value;
  if (Object.is(current[field], next)) return drafts;
  return new Map(drafts).set(session, {...current, [field]: next});
}
// A late send response clears only the submitted revision, including when its
// session is no longer selected. Newer edits and other sessions stay intact.
export function clearSubmittedDraft(drafts: SessionDrafts, session: string, submitted: ComposerDraft): SessionDrafts {
  if (sessionDraft(drafts, session) !== submitted) return drafts;
  const next = new Map(drafts);
  next.delete(session);
  return next;
}
export function useSessionComposerDraft(session: string | null) {
  // Keep unsent content in this workspace instance; don't persist credentials,
  // attachment contents or large base64 images to browser storage.
  const [drafts, setDrafts] = useState<SessionDrafts>(() => new Map());
  const setters = useMemo(() => {
    const field = <K extends keyof ComposerDraft>(key: K) => (value: SetStateAction<ComposerDraft[K]>) => setDrafts(current => updateSessionDraft(current, session, key, value));
    return {setMessageDraft: field('message'), setMentionRefs: field('references'), setImageDraft: field('images'), setFileDraft: field('files'), setIgnoreProjectMemory: field('ignoreProjectMemory')};
  }, [session]);
  return {draft: sessionDraft(drafts, session), ...setters, clearSubmitted: (id: string, submitted: ComposerDraft) => setDrafts(current => clearSubmittedDraft(current, id, submitted))};
}
