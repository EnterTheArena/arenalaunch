// Robinhood Chain (Pons) squad-launch checks, offline: real signed transactions from throwaway keys against the relay's
// own validators (relay/src/pons.js).   node tools/pons-check.mjs   (from site/)
import { Wallet, ZeroAddress, hexlify, randomBytes } from 'ethers';
import { PONS, RH_TREASURY, ROUTER_ABI, CURVE_ABI, checkPonsLaunch, checkPonsBuy, checkPonsFee, exemptionsBad, frontRun, ethWei, feeWei } from '../../relay/src/pons.js';

const dev = Wallet.createRandom(), mate = Wallet.createRandom(), outsider = Wallet.createRandom();
const curve = Wallet.createRandom().address, otherCurve = Wallet.createRandom().address;
const gas = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, type: 2 };
const params = { name: 'T', symbol: 'T', logo: 'https://x', description: '', socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: dev.address, creatorTaxBps: 200, buybackEnabled: false, expectedEconomics: hexlify(randomBytes(32)), salt: hexlify(randomBytes(32)) };
const LAUNCH_FEE = 500_000_000_000_000n, DEV_BUY = ethWei(0.05);
const launch = (o = {}) => (o.signer || dev).signTransaction({ chainId: o.chainId ?? PONS.chainId, to: o.to || PONS.router, nonce: 7, gasLimit: 4_500_000n, ...gas, value: o.value ?? LAUNCH_FEE + DEV_BUY,
  data: ROUTER_ABI.encodeFunctionData('launchAndBuy', [params, 0, o.pair || ZeroAddress, o.quoteIn ?? DEV_BUY, 0n, o.recipient || dev.address, o.exempt || [dev.address, mate.address]]) });
const buy = (o = {}) => (o.signer || mate).signTransaction({ chainId: PONS.chainId, to: o.to || curve, nonce: o.nonce ?? 3, gasLimit: o.gasLimit ?? 250_000n, ...gas, ...(o.gas || {}), value: o.value ?? ethWei(0.1),
  data: CURVE_ABI.encodeFunctionData('buy', [o.quoteIn ?? ethWei(0.1), 0n, o.recipient || (o.signer || mate).address]) });
const fee = (o = {}) => (o.signer || mate).signTransaction({ chainId: PONS.chainId, to: o.to || RH_TREASURY, nonce: o.nonce ?? 4, gasLimit: 21000n, ...gas, value: o.value ?? feeWei(ethWei(0.1)), data: o.data || '0x' });

let fails = 0; const ok = (c, w, got) => { console.log((c ? 'ok   ' : 'FAIL ') + w + (got ? '  → ' + got : '')); if (!c) fails++; };
const L = async (o, want) => { const r = checkPonsLaunch(await launch(o), dev.address); ok(want ? (r.err || '').includes(want) : !r.err, 'launch: ' + (want ? 'refuses ' : '') + JSON.stringify(Object.keys(o)), r.err); return r; };
const r0 = await L({}, null); ok(r0.quoteIn === DEV_BUY && r0.nonce === 7 && r0.exemptions.length === 2, 'launch legit: dev buy, nonce and exemptions read back');
await L({ signer: outsider }, 'not signed by the lobby dev');
await L({ to: outsider.address }, 'Pons router');
await L({ chainId: 1 }, 'not a Robinhood Chain');
await L({ recipient: outsider.address }, 'goes to someone else');
await L({ pair: outsider.address }, 'priced in ETH');
await L({ quoteIn: ethWei(150), value: LAUNCH_FEE + ethWei(150) }, 'between 0 and 100');
await L({ value: DEV_BUY - 1n }, 'does not pay for its dev buy');
ok(!!checkPonsLaunch('0xdeadbeef', dev.address).err, 'launch: garbage refused');

const B = async (o, want, wantWei = ethWei(0.1)) => { const r = checkPonsBuy(await buy(o), mate.address, curve, wantWei); ok(want ? (r.err || '').includes(want) : !r.err, 'buy: ' + (want ? 'refuses ' : '') + JSON.stringify(Object.keys(o)), r.err); return r; };
const b0 = await B({}, null); ok(b0.wei === ethWei(0.1) && b0.nonce === 3, 'buy legit: amount and nonce read back');
await B({ signer: outsider }, 'not signed by your wallet');
await B({ to: otherCurve }, 'curve');
await B({ recipient: outsider.address }, 'someone else');
await B({ value: ethWei(0.2) }, 'does not match');
await B({ quoteIn: ethWei(0.2), value: ethWei(0.2) }, 'amount mismatch');
await B({ gasLimit: 50_000n }, 'gas limit too low');
await B({ gasLimit: 5_000_000n, gas: { maxFeePerGas: 10_000_000_000n } }, 'gas cost above');

const F = async (o, want) => { const e = checkPonsFee(await fee(o), mate.address, ethWei(0.1), 3); ok(want ? (e || '').includes(want) : !e, 'fee: ' + (want ? 'refuses ' : '') + JSON.stringify(Object.keys(o)), e); };
await F({}, null);
await F({ to: outsider.address }, 'treasury');
await F({ value: feeWei(ethWei(0.1)) - 1n }, '3% launch fee is wrong');
await F({ nonce: 9 }, 'right after the buy');
await F({ signer: outsider }, 'same wallet');
await F({ data: '0x1234' }, 'plain transfer');
ok(feeWei(ethWei(1)) === ethWei(0.03), 'the fee on 1 ETH is 0.03 ETH');

ok(exemptionsBad([dev.address.toLowerCase(), mate.address.toLowerCase()], [dev.address, mate.address]) === null, 'exemptions: lobby wallets only → ok');
ok(!!exemptionsBad([dev.address.toLowerCase(), outsider.address.toLowerCase()], [dev.address, mate.address]), 'exemptions: an outside wallet → refused');
ok(!frontRun(DEV_BUY, DEV_BUY) && !frontRun(DEV_BUY - 10n ** 15n, DEV_BUY), 'front-run guard: the curve holding the dev buy (or less, after fees) is fine');
ok(frontRun(DEV_BUY + ethWei(0.01), DEV_BUY), 'front-run guard: 0.01 ETH more than the dev buy → someone bought first');

console.log(fails ? fails + ' FAILED' : 'all Pons checks passed'); process.exit(fails ? 1 : 0);
