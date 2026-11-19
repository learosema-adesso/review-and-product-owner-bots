import { applyToCheckout } from './bullybot/applyfix.mjs';
import { clampFixMaxLines } from './bullybot/fix.mjs';

// Run in the checkout of the pull request. The proposal is data from a job output, nothing in it is trusted.
let proposal;
try {
  proposal = JSON.parse(process.env.PROPOSAL ?? '');
} catch {
  console.error('::error::There is no usable fix proposal.');
  process.exit(1);
}
const result = applyToCheckout({
  proposal,
  root: process.cwd(),
  maxLines: clampFixMaxLines(process.env.BULLYBOT_FIX_MAX_LINES),
});
if (!result.ok) {
  console.error(`::error::The fix was not applied: ${result.reason}.`);
  process.exit(1);
}
console.log(`Applied the fix to ${proposal.path}.`);
