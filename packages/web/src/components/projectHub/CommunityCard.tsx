import React, { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AVATAR_COLORS,
  type DirectoryDocument,
  type DirectoryDocumentSpace,
  type DirectoryEntry,
} from '@backspace/shared';
import { useExploreStore, type TaggedExploreSpace, type TaggedJoinRequest } from '../../stores/exploreStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceJoin } from '../../hooks/useSpaceJoin';
import { canonicalOrigin } from '../../utils/directory';
import type { CommunityTarget } from '../../utils/projectLinks';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { REQUEST_MESSAGE_MAX_LENGTH } from '../chat/SpaceCard';
import { HUB_ACTION, HubCard } from './HubCard';

// ─── Pure parts ─────────────────────────────────────────────────────────────

/** Where the user stands with the community space, from what the session already holds. */
export type CommunityStatus = 'member' | 'pending' | 'not-member';

/**
 * Whether the user is in the community space, has asked to join it, or
 * neither, read from the spaces and join requests the session already holds.
 *
 * Space ids are local to their instance, so a space or request only matches
 * on (origin, id), never on the id alone. Origins are compared as
 * `new URL(x).origin` on both sides, so a trailing slash or a differently
 * cased host does not defeat the match; the stores tag the home instance with
 * `''`, which is read as `homeOrigin` (the caller passes
 * `window.location.origin`). A target whose origin does not parse matches
 * nothing. Membership wins over a pending request that has not caught up yet.
 */
export function communityStatus(
  target: CommunityTarget,
  homeOrigin: string,
  spaces: readonly TaggedSpace[],
  myRequests: readonly TaggedJoinRequest[],
): CommunityStatus {
  const wanted = canonicalOrigin(target.origin);
  if (wanted === null) return 'not-member';
  const onTarget = (tag: string): boolean => canonicalOrigin(tag === '' ? homeOrigin : tag) === wanted;

  if (spaces.some((space) => space.id === target.spaceId && onTarget(space._instanceOrigin))) {
    return 'member';
  }
  if (myRequests.some((r) => r.status === 'pending' && r.spaceId === target.spaceId && onTarget(r._instanceOrigin))) {
    return 'pending';
  }
  return 'not-member';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseSpace(raw: unknown): DirectoryDocumentSpace | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, icon, banner, avatarColor, visibility, memberCount, createdAt } = raw;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (!isNullableString(description) || !isNullableString(icon) || !isNullableString(banner)) return null;
  if (visibility !== 'public' && visibility !== 'request') return null;
  if (!isFiniteNumber(memberCount) || !isFiniteNumber(createdAt)) return null;
  return {
    id,
    name,
    description,
    icon,
    banner,
    // Cosmetic: a colour this build does not know is dropped, not fatal.
    avatarColor: AVATAR_COLORS.find((color) => color === avatarColor) ?? null,
    visibility,
    memberCount,
    createdAt,
  };
}

/**
 * The directory document another instance serves on
 * `GET /api/directory/spaces`, validated, or null when it is not one.
 *
 * The answer is remote input, so every field the card or the connect-and-join
 * dialog reads is checked for its type and copied into a fresh object;
 * unknown fields never pass through. Any malformed space fails the whole
 * document, the rule the directory hub applies to the same document: an
 * instance's own endpoint never produces one, so it means a broken or foreign
 * server. The document's `origin` is returned as sent and never trusted; the
 * card uses its configured origin.
 */
export function parseDirectoryDocument(payload: unknown): DirectoryDocument | null {
  if (!isRecord(payload)) return null;
  const { schema, origin, instance, spaces } = payload;
  if (schema !== 1 || typeof origin !== 'string') return null;

  if (!isRecord(instance)) return null;
  const { name, federatedRegistrationOpen, version } = instance;
  if (typeof name !== 'string' || typeof federatedRegistrationOpen !== 'boolean') return null;
  if (version !== undefined && !isNullableString(version)) return null;

  if (!Array.isArray(spaces)) return null;
  const parsedSpaces: DirectoryDocumentSpace[] = [];
  for (const raw of spaces) {
    const space = parseSpace(raw);
    if (space === null) return null;
    parsedSpaces.push(space);
  }

  return {
    schema: 1,
    origin,
    instance: { name, federatedRegistrationOpen, version: version ?? null },
    spaces: parsedSpaces,
  };
}

/** How long the listing request may take before the card calls the instance unreachable. */
const LISTING_TIMEOUT_MS = 10_000;

type ListingFailure = 'unreachable' | 'notListed';

type ListingResult =
  | { ok: true; document: DirectoryDocument; space: DirectoryDocumentSpace }
  | { ok: false; reason: ListingFailure };

/**
 * Read the community instance's directory document and find the space in it.
 * A network error, the timeout, a non-2xx status, a body that is not JSON or
 * JSON that is not a directory document all say `unreachable`; a valid
 * document without the space says `notListed`.
 */
async function loadListing(target: CommunityTarget): Promise<ListingResult> {
  let payload: unknown;
  try {
    const response = await fetch(`${target.origin}/api/directory/spaces`, {
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: 'unreachable' };
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  const document = parseDirectoryDocument(payload);
  if (document === null) return { ok: false, reason: 'unreachable' };
  const space = document.spaces.find((s) => s.id === target.spaceId);
  if (space === undefined) return { ok: false, reason: 'notListed' };
  return { ok: true, document, space };
}

// ─── Presentation ───────────────────────────────────────────────────────────

const noteClass = 'w-full text-[12px] text-txt-danger';

function CommunityIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function PendingButton() {
  const { t } = useTranslation('project');
  return (
    <button
      type="button"
      disabled
      className={HUB_ACTION.waiting}
    >
      {t('community.pending')}
    </button>
  );
}

function JoiningButton() {
  const { t } = useTranslation('project');
  return (
    <button type="button" disabled aria-busy="true" className={HUB_ACTION.primary}>
      <LoadingSpinner size={16} />
      {t('community.join')}
    </button>
  );
}

/**
 * The join for a community space on the home instance, mounted once the
 * listing has been read. It runs the same `useSpaceJoin` state machine as the
 * Explore cards and continues the user's click on mount: a public space is
 * joined straight away, a request space opens its message field.
 */
function HomeCommunityJoin({
  space,
  onJoined,
  onCancel,
}: {
  space: TaggedExploreSpace;
  onJoined: (spaceId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['project', 'spaces', 'common']);
  const {
    isPublic,
    isPending,
    joining,
    joinError,
    showRequestForm,
    requestMessage,
    setRequestMessage,
    openRequestForm,
    join,
    sendRequest,
  } = useSpaceJoin(space);

  const runJoin = useCallback(async () => {
    const full = await join();
    if (full) onJoined(full.id);
  }, [join, onJoined]);

  // Once per mount, including under StrictMode's effect replay: the ref
  // survives it, so a public space is never joined twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (isPublic) void runJoin();
    else openRequestForm();
  }, [isPublic, runJoin, openRequestForm]);

  return isPending ? (
    <PendingButton />
  ) : isPublic ? (
    joinError && !joining ? (
      <>
        <p className={noteClass}>{joinError}</p>
        <button type="button" onClick={() => void runJoin()} className={HUB_ACTION.primary}>
          {t('project:community.retry')}
        </button>
      </>
    ) : (
      <JoiningButton />
    )
  ) : !showRequestForm ? (
    // The frame before the mount effect opens the form.
    <JoiningButton />
  ) : (
    <div className="w-full space-y-2">
      {joinError && <p className={noteClass}>{joinError}</p>}
      <textarea
        value={requestMessage}
        onChange={(e) => setRequestMessage(e.target.value.slice(0, REQUEST_MESSAGE_MAX_LENGTH))}
        placeholder={t('spaces:explore.requestMessagePlaceholder')}
        rows={2}
        className="input-standard w-full resize-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void sendRequest()}
          disabled={joining}
          className="flex-1 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-[#13131a] text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {joining ? t('spaces:explore.sendingRequest') : t('spaces:explore.sendRequest')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
        >
          {t('common:actions.cancel')}
        </button>
      </div>
    </div>
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; reason: ListingFailure }
  | { kind: 'home'; space: TaggedExploreSpace };

/**
 * "Join the Backspace community": joins the project's community space, on
 * whichever instance `target` names.
 *
 * Privacy: nothing contacts the community instance until the user clicks
 * Join. On mount the card only asks for pending join requests, which goes to
 * the home instance and to instances the session is already connected to, so
 * the copy is static rather than the space's live name or member count.
 *
 * A remote space is handed to the connect-and-join dialog, which owns
 * connecting, the password step, account reuse and the request message; a
 * space on the home instance is joined in the card through `useSpaceJoin`.
 * Either way a successful join lands in `spaceStore` and the card turns to
 * Open on its own.
 */
export function CommunityCard(props: { target: CommunityTarget }): JSX.Element {
  const { target } = props;
  const { t } = useTranslation('project');
  const navigate = useNavigate();

  const spaces = useSpaceStore((s) => s.spaces);
  const myRequests = useExploreStore((s) => s.myRequests);
  const fetchMyRequests = useExploreStore((s) => s.fetchMyRequests);
  const openModal = useUIStore((s) => s.openModal);
  const activeModal = useUIStore((s) => s.activeModal);

  const status = communityStatus(target, window.location.origin, spaces, myRequests);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    void fetchMyRequests();
  }, [fetchMyRequests]);

  // A listing answer that arrives after unmount, or after a newer click, is dropped.
  const loadSeq = useRef(0);
  useEffect(() => () => { loadSeq.current += 1; }, []);

  // Membership or a pending request ends whatever join was under way. Without
  // this, leaving the space later (or a declined request) would bring back a
  // stale phase, and a remounted home join would join again unasked.
  useEffect(() => {
    if (status === 'not-member') return;
    loadSeq.current += 1;
    setPhase({ kind: 'idle' });
  }, [status]);

  // After the dialog closes, whatever it did (a request, a join, nothing) is
  // on the instance; asking again is how a request shows up as pending here.
  const awaitingDialog = useRef(false);
  useEffect(() => {
    if (!awaitingDialog.current || activeModal === 'connectAndJoin') return;
    awaitingDialog.current = false;
    void fetchMyRequests();
  }, [activeModal, fetchMyRequests]);

  const landOnSpace = useCallback((spaceId: string) => {
    useSpaceStore.getState().setCurrentSpace(spaceId);
    const ui = useUIStore.getState();
    if (ui.isMobile) ui.setMobileTab('spaces');
    navigate(`/channels/${spaceId}`);
  }, [navigate]);

  const resetToIdle = useCallback(() => setPhase({ kind: 'idle' }), []);

  const handleJoin = async () => {
    const seq = ++loadSeq.current;
    setPhase({ kind: 'loading' });
    const result = await loadListing(target);
    if (seq !== loadSeq.current) return;

    if (!result.ok) {
      setPhase({ kind: 'failed', reason: result.reason });
      return;
    }

    const homeOrigin = canonicalOrigin(window.location.origin);
    const isHomeTarget = homeOrigin !== null && canonicalOrigin(target.origin) === homeOrigin;
    if (isHomeTarget) {
      // exploreStore reaches the home instance only through the '' tag.
      setPhase({ kind: 'home', space: { ...result.space, _instanceOrigin: '', joined: false } });
      return;
    }

    // The configured origin, never the document's claim about itself.
    const entry: DirectoryEntry = {
      ...result.space,
      origin: target.origin,
      instanceName: result.document.instance.name,
      federatedRegistrationOpen: result.document.instance.federatedRegistrationOpen,
    };
    setPhase({ kind: 'idle' });
    awaitingDialog.current = true;
    openModal('connectAndJoin', { entry });
  };

  let action: JSX.Element;
  if (status === 'member') {
    action = (
      <button
        type="button"
        onClick={() => landOnSpace(target.spaceId)}
        className={HUB_ACTION.quiet}
      >
        {t('community.open')}
      </button>
    );
  } else if (status === 'pending') {
    action = <PendingButton />;
  } else if (phase.kind === 'home') {
    action = <HomeCommunityJoin space={phase.space} onJoined={landOnSpace} onCancel={resetToIdle} />;
  } else if (phase.kind === 'loading') {
    action = <JoiningButton />;
  } else if (phase.kind === 'failed') {
    action = (
      <>
        <p className={noteClass}>
          {phase.reason === 'notListed' ? t('community.notListed') : t('community.unreachable')}
        </p>
        <button type="button" onClick={() => void handleJoin()} className={HUB_ACTION.primary}>
          {t('community.retry')}
        </button>
      </>
    );
  } else {
    action = (
      <button type="button" onClick={() => void handleJoin()} className={HUB_ACTION.primary}>
        {t('community.join')}
      </button>
    );
  }

  return (
    <HubCard accent="mint" icon={<CommunityIcon />} title={t('community.title')} body={t('community.body')}>
      {action}
    </HubCard>
  );
}
