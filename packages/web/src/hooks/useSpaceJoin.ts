import { useState } from 'react';
import { useExploreStore, type TaggedExploreSpace } from '../stores/exploreStore';
import type { SpaceWithChannelsAndMembers } from '@backspace/shared';

export interface SpaceJoinControls {
  isJoined: boolean;
  isPublic: boolean;
  isPending: boolean;
  joining: boolean;
  joinError: string;
  showRequestForm: boolean;
  requestMessage: string;
  setRequestMessage: (v: string) => void;
  openRequestForm: () => void;
  cancelRequestForm: () => void;
  join: () => Promise<SpaceWithChannelsAndMembers | null>;
  sendRequest: () => Promise<void>;
}

/**
 * Shared join/request state machine over exploreStore, used by both the full
 * Explore SpaceCard and the compact JoinSpace modal preview card. Single source
 * of truth so the two surfaces cannot drift.
 */
export function useSpaceJoin(space: TaggedExploreSpace): SpaceJoinControls {
  const publicJoin = useExploreStore((s) => s.publicJoin);
  const requestJoin = useExploreStore((s) => s.requestJoin);
  const myRequests = useExploreStore((s) => s.myRequests);

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestMessage, setRequestMessage] = useState('');
  const [localRequestSent, setLocalRequestSent] = useState(false);

  const isJoined = space.joined === true;
  const isPublic = space.visibility === 'public';
  const isPending =
    localRequestSent ||
    myRequests.some((r) => r.spaceId === space.id && r.status === 'pending');

  // On success the caller navigates away and this component unmounts, so we do
  // not reset `joining` — matches the pre-refactor SpaceCard behavior and
  // avoids a flash of the enabled button before navigation.
  const join = async (): Promise<SpaceWithChannelsAndMembers | null> => {
    setJoining(true);
    setJoinError('');
    try {
      return await publicJoin(space);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
      return null;
    }
  };

  const sendRequest = async (): Promise<void> => {
    setJoining(true);
    setJoinError('');
    try {
      await requestJoin(space, requestMessage.trim() || undefined);
      setLocalRequestSent(true);
      setShowRequestForm(false);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setJoining(false);
    }
  };

  return {
    isJoined,
    isPublic,
    isPending,
    joining,
    joinError,
    showRequestForm,
    requestMessage,
    setRequestMessage,
    openRequestForm: () => setShowRequestForm(true),
    cancelRequestForm: () => setShowRequestForm(false),
    join,
    sendRequest,
  };
}
