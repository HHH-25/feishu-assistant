import { z } from 'zod/v4';
import { BridgeError } from './errors.js';

export const messageTime=z.union([
  z.iso.datetime({offset:true,precision:0}),
  z.number().int().nonnegative().max(8640000000000),
]).describe('优先使用带时区且精确到秒的 ISO 日期时间，如 2026-10-19T00:00:00+08:00；兼容 Unix 秒。复查时原样沿用已确认的起止时间，不重新估算。');

export function messageTimeSeconds(value:string|number):number {
  if(!messageTime.safeParse(value).success) throw new BridgeError('VALIDATION','时间必须是带时区的 ISO 日期时间（精确到秒）或有效的非负 Unix 秒');
  const seconds=typeof value==='number'?value:Date.parse(value)/1000;
  if(!Number.isSafeInteger(seconds)||seconds<0||Number.isNaN(new Date(seconds*1000).getTime()))
    throw new BridgeError('VALIDATION','时间超出支持范围');
  return seconds;
}

export const chatPeriod=z.enum(['last_7_days','yesterday','today','this_week','last_week']);
export type ChatRangeInput={period?:z.infer<typeof chatPeriod>;start_time?:string|number;end_time?:string|number};

export function resolveChatRange(input:ChatRangeInput,now=Date.now()) {
  const explicit=input.start_time!==undefined||input.end_time!==undefined;
  if(explicit) {
    if(input.period||input.start_time===undefined||input.end_time===undefined)
      throw new BridgeError('VALIDATION','请指定相对时间范围，或同时指定开始与结束时间，不能混用');
    const start=messageTimeSeconds(input.start_time),end=messageTimeSeconds(input.end_time);
    if(end<=start)throw new BridgeError('VALIDATION','结束时间必须晚于开始时间');
    return {start,end,period:'custom' as const};
  }
  const period=input.period??'last_7_days';
  if(!chatPeriod.safeParse(period).success)throw new BridgeError('VALIDATION','不支持的相对时间范围');
  const end=Math.floor(now/1000),day=86400,offset=8*3600;
  const midnight=Math.floor((end+offset)/day)*day-offset;
  const weekday=new Date((midnight+offset)*1000).getUTCDay();
  const monday=midnight-((weekday+6)%7)*day;
  switch(period) {
    case 'last_7_days':return {start:end-7*day,end,period};
    case 'yesterday':return {start:midnight-day,end:midnight-1,period};
    case 'today':return {start:midnight,end,period};
    case 'this_week':return {start:monday,end,period};
    case 'last_week':return {start:monday-7*day,end:monday-1,period};
  }
}
