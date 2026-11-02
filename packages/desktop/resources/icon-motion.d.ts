export interface IconMotionDefinition { duration: number; keyframes: Keyframe[] }
export function installIconMotion(document: Document, definitions: Record<string, IconMotionDefinition>): () => void;
