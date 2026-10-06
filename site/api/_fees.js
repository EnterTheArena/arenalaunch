// arenalaunch's fees, shared by the page (src/, bundled by esbuild) and the site's API functions: one place, so they
// cannot drift. It lives in api/ because src/ is not uploaded to Vercel; the leading _ keeps it from being served.
export const TREASURY = '3kNft1YMHsX4WgFDAq7yri5fGNrzdsBX4SxLhFLLBKez';
export const LAUNCH_TAX_BPS = 300, HUSHER_TAX_BPS = 200;
// the private-transfer fee for an amount leaving the wallet (lamports): the order gets the rest
export const husherFee = (totalLamports) => Math.floor(totalLamports * HUSHER_TAX_BPS / 10000);
// the smallest fee that covers an order of this size (the inverse of husherFee: order + fee leaves the wallet)
export const husherFeeOk = (orderLamports, feeLamports) => feeLamports >= husherFee(orderLamports + feeLamports) && feeLamports > 0;
