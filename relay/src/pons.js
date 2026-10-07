// ============================================================================
// Robinhood Chain (Pons v2) squad launches — the checks the relay runs on every transaction, kept free of network
// calls so tools/pons-check.mjs can test them offline. (Network work — predicting the coin, the launch fee, the curve's
// balance — lives in index.js and is given to these functions as plain values.)
//
// How a Pons squad launch works (Robinhood Chain has no bundles):
//   - the dev pre-signs launchAndBuy (create + dev buy) with every squad wallet in snipeTaxExemptions;
//   - the coin and its curve are CREATE2 addresses, known before the launch, so each teammate pre-signs curve.buy();
//   - the relay sends the launch, waits for its receipt, checks nobody bought in between, then fires every buy at once;
//   - for the first seconds Pons taxes non-exempt buyers up to 99%, so snipers lose and the squad goes first.
// The 3% arenalaunch fee: every buyer also pre-signs a plain ETH transfer to RH_TREASURY as their NEXT transaction
// (nonce + 1). The relay only sends it after that buyer's buy (or the dev's launch) has landed, so a buy that fails or is
// never sent pays nothing.
// ============================================================================
import { Transaction as EvmTx, Interface, getAddress, ZeroAddress } from 'ethers';

export const PONS = { chainId: 4663, router: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948', factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', configId: 0 };
export const RH_TREASURY = '0x09635e14fb339fe19903a20a6673684c0d860592';
export const RH_FEE_BPS = 300n;
export const ROUTER_ABI = new Interface(['function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)']);
export const FACTORY_ABI = new Interface(['function launchFee() view returns (uint256)', 'function previewLaunchEconomics(uint256,address) view returns (bytes32)', 'function canLaunch(address) view returns (bool)', 'function launchEnabled() view returns (bool)']);
export const CURVE_ABI = new Interface(['function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256)']);

const lc = (a) => String(a || '').toLowerCase();
export const ethWei = (eth) => BigInt(Math.round(Number(eth) * 1e6)) * 10n ** 12n; // 6 decimals, same rounding as the page
export const feeWei = (wei) => (BigInt(wei) * RH_FEE_BPS) / 10000n;
const MAX_BUY = ethWei(100); // the same 100 cap as a SOL buy
const MAX_GAS_COST = 5n * 10n ** 15n; // 0.005 ETH: no transaction here may burn more than that in gas

function read(raw) {
  if (!/^0x[0-9a-fA-F]+$/.test(String(raw || '')) || String(raw).length > 20000) return { err: 'unreadable transaction' };
  let tx; try { tx = EvmTx.from(String(raw)); } catch { return { err: 'unreadable transaction' }; }
  if (!tx.signature || !tx.from) return { err: 'unsigned transaction' };
  if (Number(tx.chainId) !== PONS.chainId) return { err: 'not a Robinhood Chain transaction' };
  const price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  if (BigInt(tx.gasLimit) * BigInt(price) > MAX_GAS_COST) return { err: 'gas cost above 0.005 ETH' };
  return { tx };
}

// the dev's launch: launchAndBuy on the Pons router, paid by the dev, the coin's tokens to the dev, priced in ETH.
// Returns {tx, quoteIn, exemptions, nonce, value} or {err}. (The launch fee and the predicted addresses are checked by the
// caller with the chain: value must equal launchFee() + quoteIn.)
export function checkPonsLaunch(raw, dev) {
  const r = read(raw); if (r.err) return r; const tx = r.tx;
  if (lc(tx.from) !== lc(dev)) return { err: 'the launch is not signed by the lobby dev' };
  if (lc(tx.to) !== lc(PONS.router)) return { err: 'the launch is not sent to the Pons router' };
  let d; try { d = ROUTER_ABI.parseTransaction({ data: tx.data, value: tx.value }); } catch { d = null; }
  if (!d || d.name !== 'launchAndBuy') return { err: 'not a Pons launchAndBuy' };
  const [, , pairToken, quoteIn, , recipient, exemptions] = d.args;
  if (lc(pairToken) !== lc(ZeroAddress)) return { err: 'the coin must be priced in ETH' };
  if (lc(recipient) !== lc(dev)) return { err: 'the dev buy goes to someone else' };
  if (!(quoteIn > 0n) || quoteIn > MAX_BUY) return { err: 'the dev buy must be between 0 and 100 ETH' };
  if (tx.value < quoteIn) return { err: 'the launch does not pay for its dev buy' };
  if (exemptions.length > 40) return { err: 'too many snipe-tax exemptions' };
  return { tx, quoteIn, value: tx.value, nonce: Number(tx.nonce), exemptions: exemptions.map(lc), params: d.args[0] };
}

// a buy: curve.buy(quoteIn, minOut, self) to THIS launch's curve, paying exactly quoteIn, from the wallet itself.
// want = the exact wei expected, or null to accept any amount up to the cap. Returns {wei, nonce} or {err}.
export function checkPonsBuy(raw, wallet, curve, want = null) {
  const r = read(raw); if (r.err) return r; const tx = r.tx;
  if (lc(tx.from) !== lc(wallet)) return { err: 'not signed by your wallet' };
  if (!curve || lc(tx.to) !== lc(curve)) return { err: 'not sent to this launch\'s curve' };
  let d; try { d = CURVE_ABI.parseTransaction({ data: tx.data, value: tx.value }); } catch { d = null; }
  if (!d || d.name !== 'buy') return { err: 'not a curve buy' };
  const [quoteIn, , recipient] = d.args;
  if (tx.value !== quoteIn) return { err: 'the ETH sent does not match the buy' };
  if (lc(recipient) !== lc(wallet)) return { err: 'the tokens go to someone else' };
  if (!(quoteIn > 0n) || quoteIn > MAX_BUY) return { err: 'a buy must be more than 0 and at most 100 ETH' };
  if (want != null && quoteIn !== BigInt(want)) return { err: 'buy amount mismatch (' + quoteIn + ' vs ' + want + ')' };
  if (tx.gasLimit < 120000n) return { err: 'gas limit too low' };
  return { wei: quoteIn, nonce: Number(tx.nonce) };
}

// the 3% fee for a buy of buyWei: a plain transfer to the treasury, the wallet's NEXT transaction after the buy
export function checkPonsFee(raw, wallet, buyWei, buyNonce) {
  const r = read(raw); if (r.err) return r.err; const tx = r.tx;
  if (lc(tx.from) !== lc(wallet)) return 'the fee is not signed by the same wallet';
  if (lc(tx.to) !== lc(RH_TREASURY)) return 'the fee does not go to the arenalaunch treasury';
  if (tx.data && tx.data !== '0x') return 'the fee must be a plain transfer';
  if (tx.value !== feeWei(buyWei)) return 'the 3% launch fee is wrong (' + tx.value + ' vs ' + feeWei(buyWei) + ')';
  if (Number(tx.nonce) !== buyNonce + 1) return 'the fee must be the transaction right after the buy';
  return null;
}

// who may be exempt from the snipe tax: the lobby's own wallets only (the dev, the dev's other buying wallets, the
// lobby's members). An outside wallet exempted by the dev could buy ahead of the squad untaxed.
export function exemptionsBad(exemptions, allowed) {
  const ok = new Set([...allowed].map(lc));
  const out = exemptions.filter((e) => !ok.has(lc(e)));
  return out.length ? 'the snipe-tax exemptions include wallets outside the lobby (' + out.map((a) => a.slice(0, 6) + '…' + a.slice(-4)).join(', ') + ')' : null;
}

// the curve's ETH right after the launch landed: anything above the dev buy means someone bought before the squad
export const frontRun = (curveWei, devQuoteIn) => BigInt(curveWei) > (BigInt(devQuoteIn) * 1005n) / 1000n + 10n ** 12n;
export const checksum = (a) => getAddress(a);
