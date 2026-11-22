// ORB-004 synthetic-only cycle retry pacing. No authentication/provider
// authority is conferred. Bounded exponential delay with partial jitter.
export function syntheticCycleBackoffMs(failedCycles,{random=Math.random}={}){
  if(!Number.isSafeInteger(failedCycles)||failedCycles<0||
     typeof random!=="function")
    throw new TypeError("invalid_synthetic_worker_backoff_input");
  const sample=random();
  if(typeof sample!=="number"||!Number.isFinite(sample)||
     sample<0||sample>=1)
    throw new RangeError("invalid_synthetic_worker_backoff_sample");
  const exponential=250*2**Math.min(failedCycles,6);
  const cap=Math.min(8000,exponential);
  return Math.floor(cap*(0.75+sample*0.25));
}
