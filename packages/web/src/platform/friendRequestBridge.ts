export interface NativeFriendRequestNotice {
  requestId: string; origin: string; userId: string; sender: string; avatar?: string;
  labels: { body: string; accept: string; decline: string; close: string };
}
export interface NativeFriendRequestAction { requestId: string; origin: string; userId: string; action: 'open' | 'accepted' | 'declined' | 'dismiss' }
