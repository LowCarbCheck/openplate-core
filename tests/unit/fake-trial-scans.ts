/**
 * The scan-trial half of an `AiQuotaStore` fake, for suites whose accounts
 * carry no scan trial (M253).
 *
 * THE CLAIM AND ITS GIVE-BACK THROW, so a suite whose accounts were never meant
 * to reach the scan gate fails loudly if one does, rather than passing on a
 * fake answer. The sweep answers zero and the day counter answers "taken", which
 * is what the real store says for an instance with no trial accounts.
 * `tests/integration/scan-trial.test.ts` owns the real statements.
 */
import type { AiTrialScanStore, ReserveResult, TrialClaim } from '../../src/ai/quota-store.js';

export function createUnusedTrialScanStore(): AiTrialScanStore {
  return {
    async claimTrialScan(): Promise<TrialClaim> {
      throw new Error('this suite has no scan-trial account, so nothing should claim a scan');
    },
    async releaseTrialScan(): Promise<{ givenBack: boolean }> {
      throw new Error('this suite has no scan-trial account, so nothing should give a scan back');
    },
    async markTrialScanDelivered(): Promise<void> {
      throw new Error('this suite has no scan-trial account, so nothing should mark a scan delivered');
    },
    async purgeTrialIntakesBefore(): Promise<number> {
      return 0;
    },
    async reserveTrialInstance(): Promise<ReserveResult> {
      return { ok: true, used: 1, limit: Number.MAX_SAFE_INTEGER };
    },
    async releaseTrialInstance(): Promise<void> {},
  };
}
