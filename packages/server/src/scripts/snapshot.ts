import { getRawDb } from '../db/index.js';
import { createSnapshot, pruneSnapshots } from '../utils/backup.js';

const p = createSnapshot(getRawDb(), 'manual');
pruneSnapshots();
console.log('Manual snapshot written: ' + p);
