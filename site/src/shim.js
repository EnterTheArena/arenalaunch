// esbuild inject: Buffer for @solana/web3.js in the browser
import { Buffer } from 'buffer';
if (typeof window !== 'undefined' && !window.Buffer) window.Buffer = Buffer;
export { Buffer };
