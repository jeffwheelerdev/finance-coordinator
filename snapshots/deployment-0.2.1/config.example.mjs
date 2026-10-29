// SANITIZED EXAMPLE ONLY: identifiers are synthetic; this is not live configuration.
// Original source hashes and recovery status are in ../../docs/source-recovery.json.
export const VERSION='0.2.1';
export const A=Object.freeze({income:'00000000-0000-4000-8000-000000000001',emergency:'00000000-0000-4000-8000-000000000002',pod:'00000000-0000-4000-8000-000000000003',general:'00000000-0000-4000-8000-000000000004',project:'00000000-0000-4000-8000-000000000005',bills:'00000000-0000-4000-8000-000000000006'});
export const R=Object.freeze({funding:'00000000-0000-4000-8000-000000000007',payout:'00000000-0000-4000-8000-000000000008',sweep:'00000000-0000-4000-8000-000000000009',general:'00000000-0000-4000-8000-000000000010'});
export const TARGET=250000, EF_TARGET=1500000;
export const cycleOf=t=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${Number(p.day)<15?'01':'15'}`;};
export const localDate=t=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
export const integer=x=>Number.isSafeInteger(x)&&x>=0;
export const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
