// Unit tests for the request input caps (src/guard.ts).
//
//   npm test
//
// These guard the money: without them a caller can post anything up to
// Cloudflare's 100 MB body ceiling and every byte is billed as prompt tokens.
// Plain asserts over esbuild + node, same shape as the eval scripts — the
// Worker never runs, so this needs no wrangler and no API keys.

import { LIMITS, adminExpected, capChat, capDistill, capMemory, capTurns, dayNum, readJson, tokenAccepted } from '../src/guard';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const turns = (n: number, len: number) =>
  Array.from({ length: n }, (_, i) => ({ who: i % 2 ? 'pet' : 'user', text: `${i}`.padEnd(len, 'x') }));

console.log('\ncapTurns');
{
  const r = capTurns(turns(500, 100), LIMITS.msgs, LIMITS.msgsChars);
  ok('caps count at 40', r.length === 40, `got ${r.length}`);
  ok('keeps the NEWEST turns', r[r.length - 1]!.text!.startsWith('499'), `last=${r[r.length-1]!.text!.slice(0,5)}`);
  ok('order is oldest→newest', r[0]!.text!.startsWith('460'), `first=${r[0]!.text!.slice(0,5)}`);
}
{
  const r = capTurns(turns(40, 5000), LIMITS.msgs, LIMITS.msgsChars);
  const total = r.reduce((s, m) => s + m.text!.length, 0);
  ok('single turn truncated to 2000', r.every((m) => m.text!.length <= LIMITS.msgChars));
  ok('total stays under 12000', total <= LIMITS.msgsChars, `got ${total}`);
}
{
  const r = capTurns([{ who: 'user', text: 'x'.repeat(50_000_000) }], LIMITS.msgs, LIMITS.msgsChars);
  ok('one 50M-char turn survives as <=2000', r.length === 1 && r[0]!.text!.length === 2000, `len=${r[0]?.text?.length}`);
}
ok('non-array input is safe', capTurns('not an array', 40, 12000).length === 0);
ok('null entries skipped', capTurns([null, { text: 'hi' }, 7], 40, 12000).length === 1);

console.log('\ncapMemory');
{
  const big = Array.from({ length: 5000 }, () => ({ fact: 'y'.repeat(9999), day: 3 }));
  const r = capMemory(big);
  ok('caps count at 80', r.length === 80, `got ${r.length}`);
  ok('caps each fact at 300', r.every((m) => m.fact!.length === 300));
}
ok('junk day coerced', capMemory([{ fact: 'a', day: '9'.repeat(1000) as never }])[0]!.day === 1);
ok('negative day coerced', capMemory([{ fact: 'a', day: -5 }])[0]!.day === 1);

console.log('\ndayNum');
ok('normal passes through', dayNum(42) === 42);
ok('huge string rejected', dayNum('9'.repeat(500)) === 1);
ok('NaN rejected', dayNum('abc') === 1);
ok('float truncated', dayNum(7.9) === 7);

console.log('\ncapChat drops unknown fields');
{
  const r = capChat({ deviceId: 'd'.repeat(9999), day: 5, messages: turns(3, 10) } as never) as Record<string, unknown>;
  ok('deviceId capped at 64', (r.deviceId as string).length === 64);
  ok('no stray keys', !('charName' in r) && !('voice' in r));
  const r2 = capChat({ charName: 'x', voice: 'y'.repeat(100000), messages: [] } as never) as Record<string, unknown>;
  ok('unknown fields not carried', r2.charName === undefined && r2.voice === undefined);
}

console.log('\ncapDistill');
{
  const r = capDistill({ context: turns(500, 100), messages: turns(500, 100) } as never);
  ok('context capped at 20', r.context!.length === 20, `got ${r.context!.length}`);
  ok('messages capped at 40', r.messages!.length === 40, `got ${r.messages!.length}`);
}

console.log('\nreadJson body ceiling');
{
  const mk = (bytes: number, declare: boolean) => {
    const payload = JSON.stringify({ messages: [{ who: 'user', text: 'x'.repeat(bytes) }] });
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (declare) h['content-length'] = String(payload.length);
    return new Request('https://x/chat', { method: 'POST', headers: h, body: payload });
  };
  const small = await readJson(mk(1000, true));
  ok('normal body parses', small.ok === true);
  const big = await readJson(mk(200_000, true));
  ok('declared oversize → 413', !big.ok && big.status === 413);
  const sneaky = await readJson(mk(200_000, false));
  ok('undeclared oversize → 413 (stream counter)', !sneaky.ok && sneaky.status === 413);
  const junk = await readJson(new Request('https://x/chat', { method: 'POST', body: 'not json' }));
  ok('malformed → 400', !junk.ok && junk.status === 400);
  const arr = await readJson(new Request('https://x/chat', { method: 'POST', body: '[1,2,3]' }));
  ok('top-level array rejected', !arr.ok && arr.status === 400);
}


console.log('\ndistill turn-index alignment');
{
  const r = capDistill({ messages: turns(500, 100) } as never);
  ok('distill keeps the OLDEST chunk turns', r.messages![0]!.text!.startsWith('0'), `first=${r.messages![0]!.text!.slice(0,4)}`);
  ok('distill turn N maps to sent index N', r.messages![9]!.text!.startsWith('9'), `10th=${r.messages![9]!.text!.slice(0,4)}`);
  const c = capDistill({ context: turns(500, 100) } as never);
  ok('distill context still keeps NEWEST', c.context![c.context!.length-1]!.text!.startsWith('499'));
  const chat = capChat({ messages: turns(500, 100) } as never);
  ok('chat still keeps NEWEST', chat.messages![chat.messages!.length-1]!.text!.startsWith('499'));
}

console.log('\ntoken rotation (tokenAccepted / adminExpected)');
{
  ok('single token matches', tokenAccepted('abc', 'abc'));
  ok('single token rejects other', !tokenAccepted('abc', 'xyz'));
  ok('rejects missing header', !tokenAccepted('abc', null));
  ok('empty config = open dev', tokenAccepted('', 'anything') && tokenAccepted(undefined, null));
  // the rotation window: both the new and the retired build keep working
  ok('list accepts NEW token', tokenAccepted('new,old', 'new'));
  ok('list accepts OLD token', tokenAccepted('new,old', 'old'));
  ok('list rejects a third value', !tokenAccepted('new,old', 'other'));
  ok('whitespace around entries tolerated', tokenAccepted(' new , old ', 'old'));
  ok('empty entries ignored', !tokenAccepted('new,,old', ''));
  // after the window closes, the retired value must actually stop working
  ok('dropping old locks it out', !tokenAccepted('new', 'old'));

  ok('admin uses ADMIN_TOKEN when set', adminExpected('adm', 'new,old') === 'adm');
  ok('admin falls back to FIRST app token', adminExpected(undefined, 'new,old') === 'new');
  ok('admin blank when nothing set', adminExpected(undefined, undefined) === '');
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
