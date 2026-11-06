// One frame grid for video seeking, chart cursors and displayed timestamps.
export function frameAt(times, t, start=-Infinity, end=Infinity){
 if(!times.length)return {index:0,time:Math.max(start,Math.min(end,t))};
 const lower=v=>{let lo=0,hi=times.length;while(lo<hi){const m=(lo+hi)>>>1;if(times[m]<v)lo=m+1;else hi=m}return lo};
 const first=lower(start),last=Math.min(times.length-1,lower(end)+(times[lower(end)]===end?0:-1));
 if(first>last)return {index:Math.min(times.length-1,first),time:Math.max(start,Math.min(end,t))};
 const i=Math.max(first,Math.min(last,lower(t))),prev=Math.max(first,i-1);
 const index=Math.abs(times[prev]-t)<=Math.abs(times[i]-t)?prev:i;
 return {index,time:times[index]};
}
export function mediaTime(time,origin,offset=0){return time-origin+offset}
