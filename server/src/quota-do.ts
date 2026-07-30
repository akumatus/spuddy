// Per-device daily quota — one Durable Object per deviceId.
//
// Replaces the KV counters (q:<id>:<date>). Three problems went away at once:
// KV's free plan allows only 1,000 writes/day and the counters were one write
// per successful reply, so the whole service capped at ~1,000 replies/day; a
// failed counter write after a successful model call meant the user paid the
// provider bill yet got a 500, with the counter frozen (unmetered) from then
// on; and KV's eventual consistency dropped increments under concurrency. A DO
// is a single serialized instance per id, so counting is atomic, and the free
// plan allows 100,000 DO requests/day — a chat reply spends two.
//
// The worker passes today's date (util.today, UTC) into every call so the
// "day" definition stays in one place; stored state from an older date reads
// as zero. No alarm-based cleanup: a device's state is ~50 bytes overwritten
// daily, so even a flood of made-up deviceIds costs megabytes against the
// 5 GB free storage ceiling — and the per-IP rate limit bounds that flood
// long before storage matters.

import { DurableObject } from 'cloudflare:workers';

// `used` counts replies actually delivered; `tries` counts every call that
// reached a provider, answered or not. Two counters because they defend against
// different things — see the tryLimit note in worker.ts.
interface DayCount {
  date: string;
  used: number;
  tries: number;
}

const EMPTY = { used: 0, tries: 0 };

export class DeviceQuota extends DurableObject {
  // Today's counters plus any standing grant. The counters reset with the date;
  // the grant does not — it is what a redeemed passphrase bought, and it should
  // outlive every daily rollover.
  async state(date: string): Promise<{ used: number; tries: number; grant: number }> {
    const [cur, grant] = await Promise.all([
      this.ctx.storage.get<DayCount>('q'),
      this.ctx.storage.get<number>('grant'),
    ]);
    const counts = cur && cur.date === date ? { used: cur.used, tries: cur.tries || 0 } : EMPTY;
    return { ...counts, grant: grant || 0 };
  }

  // Raise this device's daily budget for good. Only ever called after an invite
  // DO confirmed the passphrase was unused, and only upward — replaying a
  // smaller code can never take away a bigger grant.
  async grant(limit: number): Promise<number> {
    const cur = (await this.ctx.storage.get<number>('grant')) || 0;
    if (limit <= cur) return cur;
    await this.ctx.storage.put('grant', limit);
    return limit;
  }

  // Record one attempt. `ok` marks it as having produced a real reply, which is
  // the only thing that spends the reply budget; a failed provider walk still
  // costs the user nothing they can feel. Both counters advance either way, so
  // deliberate failures cannot be farmed for unmetered model calls.
  //
  // Two in-flight calls can both pass the gate and land a device a couple past
  // the limit; that tolerance is inherited from the KV design and is fine for a
  // daily budget.
  async bump(date: string, ok: boolean): Promise<void> {
    const cur = await this.state(date);
    await this.ctx.storage.put<DayCount>('q', {
      date,
      used: cur.used + (ok ? 1 : 0),
      tries: cur.tries + 1,
    });
  }
}

// One Durable Object per passphrase — the thing that makes "single use" true
// rather than merely likely. A DO instance is globally unique for its name and
// serializes its calls, so two people racing on the same phrase cannot both
// win; a KV read-then-write could let both through.
export class InviteCode extends DurableObject {
  // First caller takes it. A replay by the SAME device is idempotent (someone
  // retyping their phrase should not feel broken), while any other device is
  // simply refused — the worker then treats the message as ordinary chat, so a
  // leaked-and-spent phrase reveals nothing about having ever been valid.
  async redeem(deviceId: string): Promise<{ ok: boolean; already: boolean }> {
    const by = await this.ctx.storage.get<string>('by');
    if (by) return { ok: by === deviceId, already: true };
    await this.ctx.storage.put('by', deviceId);
    return { ok: true, already: false };
  }
}
