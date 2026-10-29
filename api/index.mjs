import { waitUntil } from '@vercel/functions';
import { createApp } from '../lib/app.mjs';

export default createApp({ background: (promise) => waitUntil(promise) });
