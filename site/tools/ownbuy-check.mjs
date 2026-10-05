// Proves each teammate buys on THEIR OWN wallet: builds 3 teammates' buys exactly as the client does, signs each with that
// teammate's own key, then DECODES every transaction and checks: the fee payer is that wallet, the tokens go to that wallet,
// the only signer is that wallet, and the dev is not a signer. Also decodes the dev's create (the dev pays only their own buy).
//   node tools/build-sim.mjs ownbuy-check && node tools/.ownbuy-check.bundle.mjs
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, VersionedMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pumpState, buildCreate, buyIxsFor, tokensFor, tokensAt, altKeysOf, signersOf, PUMP, BUY_USER } from '../src/pump.js';

const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const getAccounts = async (a) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [a, { encoding: 'base64' }] }) })).json()).result.value;
const bh = Keypair.generate().publicKey.toBase58();
const st = await pumpState(getAccounts);
const dev = Keypair.generate(), mint = Keypair.generate();
const built = await buildCreate(st, { mint: mint.publicKey, creator: dev.publicKey, name: 'Own', symbol: 'OWN', uri: 'https://x', holderReward: false, devLamports: 5e7, devMinOut: tokensFor(st, 5e7) });
const template = { ...built.template, blockhash: bh, plannedLamports: 5e7, cu: 200000, prio: 0.0005 };
const prio = (cu, p) => [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1, Math.floor(p * 1e15 / cu)) })];

// a teammate's buy, exactly as the client's memberBuyTx builds it (feePayer = owner), signed by that teammate only
function memberBuy(kp, sol) {
  const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh });
  t.add(...prio(200000, 0.0005), ...buyIxsFor(template, kp.publicKey, Math.round(sol * 1e9), new BN(1)));
  t.sign(kp);
  return t.serialize({ requireAllSignatures: true, verifySignatures: true });
}

let bad = 0; const check = (name, ok, got) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)); };

// decode a legacy tx: fee payer, who signed, and the pump-buy's "user" account (who receives the tokens)
function decode(raw) {
  const tx = Transaction.from(raw);
  const msg = tx.compileMessage();
  const payer = msg.accountKeys[0].toBase58();
  const buyIx = tx.instructions.find((ix) => ix.programId.toBase58() === PUMP);
  const user = buyIx ? buyIx.keys[BUY_USER.user].pubkey.toBase58() : null;
  // which pubkeys actually produced a valid signature
  const data = msg.serialize();
  const signers = tx.signatures.filter((s) => s.signature && ed25519.verify(s.signature, data, s.publicKey.toBytes())).map((s) => s.publicKey.toBase58());
  return { payer, user, signers };
}

const team = [['teammate A', Keypair.generate(), 0.03], ['teammate B', Keypair.generate(), 0.05], ['teammate C', Keypair.generate(), 0.02]];
for (const [name, kp, sol] of team) {
  const d = decode(memberBuy(kp, sol)); const own = kp.publicKey.toBase58();
  check(name + ' pays the fee from their own wallet', d.payer === own, d.payer);
  check(name + ' receives the tokens in their own wallet', d.user === own, d.user);
  check(name + ' is the only signer', d.signers.length === 1 && d.signers[0] === own, d.signers);
  check(name + ' — the dev did NOT sign this buy', !d.signers.includes(dev.publicKey.toBase58()), d.signers);
}

// the dev's create + dev buy: paid and signed by the dev + the mint, and the dev buy's user is the dev (not a teammate)
const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: altKeysOf(built.ixs, signersOf(built.ixs)).map((k) => new PublicKey(k)) } });
const createTx = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...built.ixs] }).compileToV0Message([alt]));
createTx.sign([mint, dev]);
{
  const vtx = VersionedTransaction.deserialize(createTx.serialize());
  const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
  const payer = keys[0];
  const data = vtx.message.serialize();
  const nreq = vtx.message.header.numRequiredSignatures;
  const signers = vtx.signatures.slice(0, nreq).map((sig, i) => ({ sig, pk: keys[i] })).filter((x) => x.sig && x.sig.some((b) => b) && ed25519.verify(x.sig, data, bs58.decode(x.pk))).map((x) => x.pk);
  check('the dev pays their own create + dev buy', payer === dev.publicKey.toBase58(), payer);
  check('only the dev and the mint sign the create', signers.length === 2 && signers.includes(dev.publicKey.toBase58()) && signers.includes(mint.publicKey.toBase58()), signers);
  check('no teammate signs the create', !team.some(([, kp]) => signers.includes(kp.publicKey.toBase58())), signers);
}

console.log(bad ? '\nFAILED' : '\nEach wallet buys its own supply, signed and paid by itself. The dev pays only the create + their own buy.');
process.exit(bad ? 1 : 0);
