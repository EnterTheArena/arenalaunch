// every coin launched through the app carries "launched on arenalaunch.bond" at the end of its description (offline)
//   node tools/ipfs-tag-check.mjs   (from site/)
import { tagged, TAG } from '../api/ipfs.js';
let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
ok(tagged('') === TAG && tagged(null) === TAG, 'no description: the description is the tag');
ok(tagged('the best coin') === 'the best coin\n\n' + TAG, 'a description gets the tag on its own line');
ok(tagged('x\n\nlaunched on arenalaunch.bond') === 'x\n\nlaunched on arenalaunch.bond' && tagged('Launched on arenalaunch.bond!').split(/arenalaunch/i).length === 2, 'never added twice');
const long = tagged('a'.repeat(600)); ok(long.length <= 500 && long.endsWith(TAG), 'a long description is trimmed to keep the tag and pump.fun\'s 500-character limit');
console.log(fails ? fails + ' FAILED' : 'all description tag checks passed'); process.exit(fails ? 1 : 0);
